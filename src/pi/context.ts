import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { contentText, type Message } from '@earendil-works/pi-ai'

/**
 * Context compaction, following pi's own design in `packages/coding-agent/src/core/compaction`:
 *
 * - A request runs while the context is below `contextWindow - reserveTokens`; above it, older turns are summarized.
 *   pi's defaults are 16384 tokens reserved and 20000 kept verbatim.
 * - The cut never lands on a tool result, so a tool call always keeps its answer; it lands on a user or assistant message,
 *   as in pi, so the kept part remains a valid transcript.
 * - The summary follows a fixed structure and is written by the conversation's own model. A second compaction merges into
 *   the previous summary instead of forgetting it.
 * - A summary that stops on `length` or fails is refused: a partial checkpoint loses the work it was meant to keep.
 *
 * pi stores a compaction as a session entry; here the summary is a message in the transcript, which survives a restart
 * because the whole transcript is persisted.
 */

/** Room kept for the answer and the provider's accounting; pi's `compaction.reserveTokens`. */
export const RESERVE_TOKENS = 16384
/** How much of the newest conversation stays verbatim; pi's `compaction.keepRecentTokens`. */
export const KEEP_RECENT_TOKENS = 20000
/** A serialized tool result is cut here in a summary request: the beginning records what happened. */
const TOOL_RESULT_CHARS = 2000
export const COMPACTION_PREFIX = '此前的对话历史已压缩为以下摘要：'
export const COMPACTION_SUFFIX = '</summary>'

export interface CompactionSettings {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: RESERVE_TOKENS,
  keepRecentTokens: KEEP_RECENT_TOKENS,
}

export interface CompactionResult {
  /** The replacement history: the leading system messages, the summary, and the kept tail. */
  messages: AgentMessage[]
  summary: string
  tokensBefore: number
  tokensAfter: number
}

const WIDE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g

/**
 * Tokens of a text, counted conservatively: CJK text is about one token per character, other text about 3.5 characters per
 * token. pi divides everything by 3.5, which undercounts Chinese badly enough that a 128k window fills unnoticed.
 */
export function estimateText(text: string): number {
  if (!text) return 0
  const wide = text.match(WIDE)?.length ?? 0
  return wide + Math.ceil((text.length - wide) / 3.5)
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateText(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (typeof part === 'string') { total += estimateText(part); continue }
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if (typeof item.text === 'string') total += estimateText(item.text)
    else if (typeof item.thinking === 'string') total += estimateText(item.thinking)
    else if (typeof item.name === 'string') total += estimateText(item.name) + estimateText(JSON.stringify(item.arguments ?? {}))
  }
  return total
}

/** Tokens one message adds to the request, as the provider will count it. */
export function estimateMessage(message: AgentMessage): number {
  const value = message as unknown as Record<string, unknown>
  return contentTokens(value.content) + contentTokens(value.sections ? Object.values(value.sections) : undefined)
}

export function estimateMessages(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0)
}

/** pi's rule: the context may use the window less what the answer needs. */
export function shouldCompact(tokens: number, window: number, settings: CompactionSettings = DEFAULT_COMPACTION): boolean {
  if (!settings.enabled || window <= 0) return false
  return tokens > window - settings.reserveTokens
}

/** Render the summary the way pi's `convertToLlm` does: a checkpoint, not a turn the model wrote. */
export function summaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `${COMPACTION_PREFIX}\n\n<summary>\n${summary}\n${COMPACTION_SUFFIX}`,
    timestamp: Date.now(),
  }
}

/** The summary a transcript already starts with, when an earlier compaction wrote one. */
export function previousSummary(messages: readonly AgentMessage[]): string | undefined {
  const first = messages.find(message => message.role !== 'system')
  if (!first || first.role !== 'user') return undefined
  const text = typeof first.content === 'string' ? first.content : contentText(first.content as Message['content'], '')
  if (!text.startsWith(COMPACTION_PREFIX)) return undefined
  const body = text.slice(text.indexOf('<summary>') + '<summary>'.length, text.lastIndexOf(COMPACTION_SUFFIX))
  return body.trim() || undefined
}

/** The leading system messages, which carry the prompt and tool declarations and are never summarized away. */
function leading(messages: readonly AgentMessage[]): AgentMessage[] {
  const prefix: AgentMessage[] = []
  let index = 0
  while (index < messages.length && messages[index]!.role === 'system') prefix.push(messages[index++]!)
  return prefix
}

/**
 * Where to start keeping. Walk back from the newest message until `keepRecentTokens` is reached, then move forward to the
 * nearest message a turn can begin at. A tool result is never a cut point: its call would be gone. An assistant message is
 * one, as in pi, and its tool results follow it and stay with it.
 */
export function findCut(messages: readonly AgentMessage[], keepRecentTokens: number): number {
  const start = leading(messages).length
  const cuttable = (message: AgentMessage): boolean => message.role === 'user' || message.role === 'assistant'
  let accumulated = 0
  for (let index = messages.length - 1; index >= start; index--) {
    accumulated += estimateMessage(messages[index]!)
    if (accumulated < keepRecentTokens) continue
    // Step back to the nearest turn start: moving forward would pass a tool result and orphan it.
    let cut = index
    while (cut > start && !cuttable(messages[cut]!)) cut--
    return cuttable(messages[cut]!) ? cut : start + 1
  }
  return start
}

/* ---------------------------------------------------------------------------------------------- summarization */

const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## 目标
[用户想要完成什么？会话覆盖多个任务时可分条列出。]

## 约束与偏好
- [用户提到的约束、偏好或要求]
- [没有则写「无」]

## 进展
### 已完成
- [x] [已完成的任务或改动]

### 进行中
- [ ] [当前工作]

### 受阻
- [遇到的问题；没有就不写这一节]

## 关键决定
- **[决定]**：[简要理由]

## 下一步
1. [接下来应当做什么，按顺序]

## 关键上下文
- [继续工作所需的数据、示例或引用]
- [不适用时写「无」]

保持每节简短。保留确切的文件路径、函数名和错误信息。`

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the EXACT format of the previous summary, in Chinese, keeping every section heading it has.`

function truncate(text: string): string {
  if (text.length <= TOOL_RESULT_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_CHARS)}\n\n[... ${text.length - TOOL_RESULT_CHARS} 个字符已省略]`
}

/**
 * The conversation as plain text, so the model summarizes it instead of continuing it. Thinking is omitted: providers drop
 * replayed thinking, so including it can make the summary request larger than the context it replaces.
 */
export function serialize(messages: readonly AgentMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : contentText(message.content as Message['content'], '')
      if (text) parts.push(`[User]: ${text}`)
    } else if (message.role === 'assistant') {
      const calls = message.content.flatMap(part => part.type === 'toolCall'
        ? [`${part.name}(${Object.entries(part.arguments as Record<string, unknown>).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')})`]
        : [])
      const text = contentText(message.content, '').trim()
      if (text) parts.push(`[Assistant]: ${text}`)
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
    } else if (message.role === 'toolResult') {
      const text = contentText(message.content as Message['content'], '')
      if (text) parts.push(`[Tool result]: ${truncate(text)}`)
    }
  }
  return parts.join('\n\n')
}

/** The prompt of one summary request, for a caller that performs the model call itself. */
export function summaryPrompt(messages: readonly AgentMessage[], previous?: string): { systemPrompt: string; prompt: string } {
  let prompt = `<conversation>\n${serialize(messages)}\n</conversation>\n\n`
  if (previous) prompt += `<previous-summary>\n${previous}\n</previous-summary>\n\n`
  return { systemPrompt: SYSTEM_PROMPT, prompt: prompt + (previous ? UPDATE_PROMPT : SUMMARY_PROMPT) }
}

/** Read a summary reply, refusing the ones that cannot serve as a checkpoint. */
export function readSummary(message: { content: unknown; stopReason: string; errorMessage?: string }): string {
  if (message.stopReason === 'error') throw new Error(`上下文压缩失败：${message.errorMessage ?? '模型调用失败'}`)
  if (message.stopReason === 'length') throw new Error('上下文压缩失败：摘要达到输出上限而被截断，未采用不完整的摘要。')
  const text = contentText(message.content as Message['content']).trim()
  if (!text) throw new Error('上下文压缩失败：模型没有返回摘要。')
  return text
}

/**
 * Compact a transcript that outgrew `window`. `summarize` performs the model call for one prompt. Returns `undefined` when
 * the context fits, which is the common case and costs one estimate.
 */
export async function compactIfNeeded(
  messages: readonly AgentMessage[],
  window: number,
  summarize: (systemPrompt: string, prompt: string) => Promise<string>,
  settings: CompactionSettings = DEFAULT_COMPACTION,
): Promise<CompactionResult | undefined> {
  const tokensBefore = estimateMessages(messages)
  if (!shouldCompact(tokensBefore, window, settings)) return undefined
  const prefix = leading(messages)
  const rest = messages.slice(prefix.length)
  // An earlier summary is merged into the next one rather than summarized again.
  const previous = previousSummary(messages)
  const body = previous ? rest.slice(1) : rest
  const cut = findCut(messages, settings.keepRecentTokens)
  const summarized = body.slice(0, Math.max(0, cut - prefix.length - (previous ? 1 : 0)))
  if (!summarized.length) return undefined
  const kept = body.slice(summarized.length)
  const { systemPrompt, prompt } = summaryPrompt(summarized, previous)
  const summary = await summarize(systemPrompt, prompt)
  const result = [...prefix, summaryMessage(summary), ...kept]
  return { messages: result, summary, tokensBefore, tokensAfter: estimateMessages(result) }
}
