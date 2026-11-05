import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * Room kept free for the answer and for the provider's own accounting: one eighth of the window, between one and twelve
 * thousand tokens. pi clamps the requested output to what the window has left, so a transcript filled to the brim leaves a
 * one-token answer that stops on `length` and reports nothing.
 */
export const HEADROOM = 12288
/** Stands in for the messages it replaces; points the model at the files instead of inventing a summary. */
export const TRIMMED = '（更早的对话已省略以控制上下文占用；需要细节时重新读取相关文件。）'

/** The part of the window the transcript itself may use. */
export function contextBudget(window: number): number {
  const headroom = Math.min(HEADROOM, Math.max(1024, Math.floor(window / 8)))
  return Math.max(1024, window - headroom)
}

const WIDE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g

/**
 * Tokens of a text, counted conservatively: CJK text is about one token per character, other text about 3.5 characters per
 * token. pi's own estimate divides everything by 3.5, which undercounts a Chinese transcript by a wide margin — the same
 * margin that let a 128k window fill up and leave a one-token answer.
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

/** An assistant message with the tool results answering it: dropping one half leaves a tool call without its result. */
function group(messages: readonly AgentMessage[]): AgentMessage[][] {
  const parts: AgentMessage[][] = []
  for (const message of messages) {
    const last = parts.at(-1)
    if (last?.[0]?.role === 'assistant' && message.role === 'toolResult') last.push(message)
    else parts.push([message])
  }
  return parts
}

/**
 * Keep a transcript within the model's window by dropping its oldest whole groups, and say what it replaced. The system
 * messages, the request that started the work and the newest steps stay; only what the window cannot hold goes.
 */
export function trimMessages(messages: readonly AgentMessage[], window: number, notice = TRIMMED): AgentMessage[] {
  if (window <= 0 || messages.length < 3) return [...messages]
  const budget = contextBudget(window)
  if (estimateMessages(messages) <= budget) return [...messages]
  const leading: AgentMessage[] = []
  let start = 0
  while (start < messages.length && messages[start]!.role === 'system') leading.push(messages[start++]!)
  const parts = group(messages.slice(start))
  const replaced = { role: 'user', content: notice, timestamp: Date.now() } as AgentMessage
  const kept: AgentMessage[][] = []
  let used = estimateMessages(leading) + estimateMessage(replaced)
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!
    // A tool result cannot stand first: its call would be gone.
    if (!kept.length && part[0]?.role === 'toolResult') continue
    const partSize = estimateMessages(part)
    if (kept.length && used + partSize > budget) break
    kept.unshift(part)
    used += partSize
  }
  // The request that started the work explains what is being asked, so it stays while it fits.
  const brief = parts[0]
  if (brief && kept[0] !== brief && brief[0]?.role === 'user' && used + estimateMessages(brief) <= budget) kept.unshift(brief)
  if (!kept.length || kept.length === parts.length) return [...messages]
  return [...leading, replaced, ...kept.flat()]
}
