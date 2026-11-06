import { Agent, type AgentMessage, type AgentOptions, type AgentTool, type StreamFn, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { getSupportedThinkingLevels, lazyStream, normalizeContext, type Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { compactIfNeeded, readSummary } from './context.js'
import { codingTools } from './tools.js'

export type PiModel = Model<'openai-completions'>
export type PiStreamFn = StreamFn
export type PiBeforeToolCall = NonNullable<AgentOptions['beforeToolCall']>
export type { AgentMessage, AgentTool }

export interface CreatePiAgentOptions {
  systemPrompt: string
  tools?: AgentTool[]
  messages?: AgentMessage[]
  cwd?: string
  beforeToolCall?: PiBeforeToolCall
  roleModel?: import('../policy.ts').RoleModel | null
  model?: PiModel
  streamFn?: PiStreamFn
}

/** The window the configured model reports, so a screen can show how full its context is before any request ran. */
export function configuredWindow(roleModel?: import('../policy.ts').RoleModel | null): number {
  try { return environmentModel(roleModel).contextWindow } catch { return 0 }
}

function environmentModel(roleModel?: import('../policy.ts').RoleModel | null): PiModel {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim()
  const id = roleModel ? roleModel.model.trim() : process.env.OPENAI_MODEL?.trim()
  if (!baseUrl) throw new Error('缺少环境变量 OPENAI_BASE_URL，请配置 OpenAI 兼容接口地址。')
  if (!id) throw new Error(roleModel ? '角色模型 model 不能为空。' : '缺少环境变量 OPENAI_MODEL，请配置模型名称。')
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('OPENAI_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OPENAI_BASE_URL 必须是无凭据、查询参数和片段的 HTTP 或 HTTPS 地址。')
  }
  const deepseek = roleModel ? roleModel.provider === 'deepseek' : url.hostname === 'deepseek.com' || url.hostname.endsWith('.deepseek.com') || /deepseek/i.test(id)
  const hasEffort = roleModel?.reasoningEffort !== undefined && roleModel.reasoningEffort !== 'off'
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: deepseek ? 'deepseek' : 'openai',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    reasoning: hasEffort || /reasoner|(?:^|[-_/])r1(?:$|[-_/])/i.test(id),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: hasEffort && !deepseek,
      maxTokensField: 'max_tokens',
      ...(deepseek ? { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true } : {}),
    },
  }
}

export function createPiAgent(options: CreatePiAgentOptions): Agent {
  if (typeof options.systemPrompt !== 'string' || !options.systemPrompt.trim()) {
    throw new Error('systemPrompt 不能为空。')
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!options.streamFn && !apiKey) {
    throw new Error('缺少环境变量 OPENAI_API_KEY，请配置接口凭据。')
  }
  const roleModel = options.roleModel
  if (roleModel && roleModel.provider !== 'openai' && roleModel.provider !== 'deepseek') {
    throw new Error('不支持角色模型 provider，仅允许 openai 或 deepseek。')
  }
  const effort = roleModel?.reasoningEffort
  const levels: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (effort !== undefined && !levels.includes(effort as ThinkingLevel)) {
    throw new Error('不支持 reasoningEffort，请使用 pi thinking level：off、minimal、low、medium、high、xhigh 或 max。')
  }
  const model = options.model ?? environmentModel(roleModel)
  if (model.api !== 'openai-completions') throw new Error('仅支持 OpenAI 兼容的 openai-completions 协议。')
  const thinkingLevel = effort as ThinkingLevel | undefined
  if (thinkingLevel !== undefined) {
    if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) {
      throw new Error('当前模型不支持配置的 reasoningEffort 级别，请调整模型或思考级别。')
    }
    if (thinkingLevel !== 'off' && (model.provider === 'deepseek' || model.compat?.supportsReasoningEffort !== true)) {
      throw new Error('当前模型接口不支持可调 reasoningEffort；DeepSeek 不支持此参数，请移除配置或使用 off。')
    }
  }
  const streamFn: PiStreamFn = options.streamFn ?? ((selectedModel, context, streamOptions) =>
    lazyStream(selectedModel, async () => streamSimple(selectedModel as PiModel, context, { ...streamOptions, apiKey })))
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      thinkingLevel,
      tools: options.tools ?? codingTools(options.cwd ?? process.cwd()),
      messages: options.messages ?? [],
    },
    streamFn,
    getApiKey: () => apiKey,
    beforeToolCall: options.beforeToolCall,
    toolExecution: 'sequential',
    transport: 'sse',
  })
  // pi compacts before a request that would overrun the window: the answer keeps `reserveTokens`, and the older turns
  // become one summary of the transcript itself. Without this the provider clamps the answer to whatever is left, which can
  // be one token — a turn that stops on `length` and reports nothing.
  //
  // The compacted transcript replaces the agent's own, so it is written to the session and the next turn does not summarize
  // the same history again. Returning it as the request context keeps the run in step within this turn.
  agent.prepareRequest = async (request, signal) => {
    const result = await compactIfNeeded(request.context.messages, model.contextWindow, async (systemPrompt, prompt) => {
      const context = normalizeContext({ systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }] })
      const response = await streamFn(model, context, { apiKey, signal })
      return readSummary(await response.result())
    })
    if (!result) return undefined
    agent.state.messages = result.messages
    return { context: { ...request.context, messages: result.messages } }
  }
  return agent
}
