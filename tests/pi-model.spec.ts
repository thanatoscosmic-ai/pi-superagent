import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { obj } from '@earendil-works/pi-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPiAgent, type AgentTool, type PiBeforeToolCall, type PiModel, type PiStreamFn } from '../src/pi/model.js'

const offlineModel: PiModel = {
  id: 'offline',
  name: '离线测试',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1000,
}

function message(model: PiModel, content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse' = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  }
}

function response(value: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: 'start', partial: value })
  stream.push({ type: 'done', reason: value.stopReason as 'stop' | 'toolUse', message: value })
  stream.end(value)
  return stream
}

let cwd: string
let server: Server | undefined

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pi-model-'))
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('OPENAI_BASE_URL', '')
  vi.stubEnv('OPENAI_MODEL', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    server = undefined
  }
  await rm(cwd, { recursive: true, force: true })
})

describe('模型工厂', () => {
  it('缺少凭据明确报错且不记录密钥', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => createPiAgent({ systemPrompt: '测试', cwd })).toThrow('OPENAI_API_KEY')
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    expect(() => createPiAgent({ systemPrompt: '测试', cwd })).toThrow('OPENAI_BASE_URL')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')
    expect(() => createPiAgent({ systemPrompt: '测试', cwd })).toThrow('OPENAI_MODEL')
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('拒绝空提示及非法或嵌入凭据的地址，不泄露输入', () => {
    expect(() => createPiAgent({ systemPrompt: '', cwd })).toThrow('systemPrompt')
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_MODEL', 'model')
    for (const url of ['invalid-private-key', 'file:///tmp', 'https://user:private-test-key@example.com', 'https://example.com?key=private-test-key']) {
      vi.stubEnv('OPENAI_BASE_URL', url)
      try {
        createPiAgent({ systemPrompt: '测试', cwd })
        throw new Error('应当拒绝地址')
      } catch (error) {
        expect(String(error)).toContain('OPENAI_BASE_URL')
        expect(String(error)).not.toContain('private-test-key')
      }
    }
  })

  it('配置 DeepSeek OpenAI 兼容协议及默认安全工具', () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1/')
    vi.stubEnv('OPENAI_MODEL', 'deepseek-reasoner')
    const agent = createPiAgent({ systemPrompt: '中文提示', cwd })
    expect(agent).toBeInstanceOf(Agent)
    expect(agent.state.model).toMatchObject({
      id: 'deepseek-reasoner', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', reasoning: true,
      compat: { maxTokensField: 'max_tokens', thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
    })
    expect(agent.state.tools.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'glob', 'grep'])
    expect(JSON.stringify(agent.state)).not.toContain('private-test-key')
  })

  it('注入 model 和 streamFn 无需环境变量即可离线运行', async () => {
    const streamFn = vi.fn<PiStreamFn>((model, context, options) => {
      expect(model).toBe(offlineModel)
      expect(context.messages.some(item => item.role === 'user')).toBe(true)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      return response(message(offlineModel, [{ type: 'text', text: '离线完成' }]))
    })
    const history = [{ role: 'user' as const, content: '历史', timestamp: 1 }]
    const agent = createPiAgent({ systemPrompt: '离线提示', tools: [], messages: history, model: offlineModel, streamFn, cwd })
    const events: string[] = []
    agent.subscribe(event => { events.push(event.type) })
    await agent.prompt('开始')
    expect(streamFn).toHaveBeenCalledOnce()
    expect(events).toContain('agent_end')
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: '离线完成' }] })
    expect(history).toHaveLength(1)
    expect(agent.state.tools).toEqual([])
  })

  it('注入模型但使用真实 stream 时仍要求凭据', () => {
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], model: offlineModel })).toThrow('OPENAI_API_KEY')
  })

  it('只注入 streamFn 时仍从环境变量解析模型', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com')
    vi.stubEnv('OPENAI_MODEL', 'deepseek-chat')
    const streamFn: PiStreamFn = () => response(message(offlineModel, []))
    const agent = createPiAgent({ systemPrompt: '测试', tools: [], streamFn })
    expect(agent.state.model.id).toBe('deepseek-chat')
  })

  it.each(['openai', 'deepseek'])('角色模型覆盖环境模型 ID，provider 使用明确配置：%s', provider => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'environment-model')
    const roleModel = { provider, model: 'role-model' }
    const agent = createPiAgent({ systemPrompt: '测试', tools: [], roleModel })
    expect(agent.state.model).toMatchObject({ id: 'role-model', name: 'role-model', provider, baseUrl: 'https://gateway.example.com/v1' })
    vi.stubEnv('OPENAI_MODEL', '')
    expect(createPiAgent({ systemPrompt: '测试', tools: [], roleModel }).state.model.id).toBe('role-model')
  })

  it.each(['anthropic', 'azure', '', 'OpenAI'])('不支持的角色 provider 明确拒绝：%s', provider => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { provider, model: 'role-model' } })).toThrow('不支持角色模型 provider')
  })

  it('roleModel 为 null 时保留环境模型逻辑', () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'deepseek-chat')
    const agent = createPiAgent({ systemPrompt: '测试', tools: [], roleModel: null })
    expect(agent.state.model).toMatchObject({ id: 'deepseek-chat', provider: 'deepseek' })
    expect(agent.state.thinkingLevel).toBe('off')
  })

  it('角色模型仍使用统一环境地址与凭据，空 model 不回退环境', () => {
    const roleModel = { provider: 'openai', model: 'role-model' }
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel })).toThrow('OPENAI_API_KEY')
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel })).toThrow('OPENAI_BASE_URL')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'fallback')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { ...roleModel, model: ' ' } })).toThrow('model 不能为空')
  })

  it.each(['minimal', 'low', 'medium', 'high'])('支持的 reasoningEffort 传递至 pi thinkingLevel 和 stream：%s', async reasoningEffort => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example.com/v1')
    const streamFn = vi.fn<PiStreamFn>((model, _context, options) => {
      expect(options?.reasoning).toBe(reasoningEffort)
      expect(model.reasoning).toBe(true)
      expect(model.compat).toMatchObject({ supportsReasoningEffort: true })
      return response(message(model as PiModel, []))
    })
    const agent = createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { provider: 'openai', model: 'o3', reasoningEffort }, streamFn })
    expect(agent.state.thinkingLevel).toBe(reasoningEffort)
    await agent.prompt('测试')
    expect(streamFn).toHaveBeenCalledOnce()
  })

  it.each(['unsupported', '', 'HIGH', 'xhigh', 'max'])('非法或模型未声明支持的 reasoningEffort 明确拒绝：%s', reasoningEffort => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example.com/v1')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { provider: 'openai', model: 'o3', reasoningEffort } })).toThrow('reasoningEffort')
  })

  it('DeepSeek 可调 effort 拒绝，off 显式传递且无配置保持原逻辑', () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')
    const roleModel = { provider: 'deepseek', model: 'deepseek-reasoner' }
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { ...roleModel, reasoningEffort: 'high' } })).toThrow('DeepSeek 不支持')
    const agent = createPiAgent({ systemPrompt: '测试', tools: [], roleModel: { ...roleModel, reasoningEffort: 'off' } })
    expect(agent.state.thinkingLevel).toBe('off')
    expect(agent.state.model.compat).toMatchObject({ supportsReasoningEffort: false })
  })

  it('注入模型也检查 thinking 元数据和接口支持，禁止静默降级', () => {
    const streamFn: PiStreamFn = () => response(message(offlineModel, []))
    const roleModel = { provider: 'openai', model: 'o3', reasoningEffort: 'high' }
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], model: offlineModel, streamFn, roleModel })).toThrow('不支持配置的 reasoningEffort')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], model: { ...offlineModel, reasoning: true, compat: { supportsReasoningEffort: false } }, streamFn, roleModel })).toThrow('接口不支持')
    expect(() => createPiAgent({ systemPrompt: '测试', tools: [], model: { ...offlineModel, reasoning: true, thinkingLevelMap: { high: null }, compat: { supportsReasoningEffort: true } }, streamFn, roleModel })).toThrow('不支持配置的 reasoningEffort')
  })

  it('beforeToolCall 接收 pi 上下文和取消信号，并能阻止工具', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '不应执行' }], details: {} }))
    const tools: AgentTool[] = [{ name: 'restricted', label: '受限工具', description: '测试', parameters: obj({}), execute }]
    const hook = vi.fn<PiBeforeToolCall>(async (context, signal) => {
      expect(context.toolCall.name).toBe('restricted')
      expect(context.args).toEqual({})
      expect(signal).toBeInstanceOf(AbortSignal)
      return { block: true, reason: '策略拒绝执行' }
    })
    let turns = 0
    const streamFn: PiStreamFn = () => response(++turns === 1
      ? message(offlineModel, [{ type: 'toolCall', id: 'call-1', name: 'restricted', arguments: {} }], 'toolUse')
      : message(offlineModel, [{ type: 'text', text: '已拒绝' }]))
    const agent = createPiAgent({ systemPrompt: '测试', model: offlineModel, streamFn, tools, beforeToolCall: hook })
    await agent.prompt('执行')
    expect(hook).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(agent.state.messages.find(item => item.role === 'toolResult')).toMatchObject({ isError: true, content: [{ type: 'text', text: '策略拒绝执行' }] })
  })

  it('真实 pi adapter 使用 chat/completions wire protocol，离线 HTTP 验证', async () => {
    const requests: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = []
    server = createServer(async (request, res) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      requests.push({ path: request.url ?? '', auth: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = { id: 'offline-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: '协议通过' }, finish_reason: null }] }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务地址无效')
    vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`)
    vi.stubEnv('OPENAI_MODEL', 'deepseek-chat')
    vi.stubEnv('OPENAI_API_KEY', 'offline-test-token')
    const agent = createPiAgent({ systemPrompt: '你是中文助手', cwd })
    await agent.prompt('测试协议')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer offline-test-token', body: { model: 'deepseek-chat', stream: true, max_tokens: 8192 } })
    expect(requests[0]!.body).not.toHaveProperty('max_completion_tokens')
    expect(requests[0]!.body).not.toHaveProperty('store')
    expect(requests[0]!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: '你是中文助手' }), expect.objectContaining({ role: 'user', content: [{ type: 'text', text: '测试协议' }] })]))
    expect(requests[0]!.body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'read', parameters: expect.objectContaining({ type: 'object' }) }) })]))
    expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: 'text', text: '协议通过' }], stopReason: 'stop' })
    const roleAgent = createPiAgent({ systemPrompt: '角色模型测试', tools: [], roleModel: { provider: 'openai', model: 'o3', reasoningEffort: 'high' } })
    await roleAgent.prompt('测试推理配置')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer offline-test-token', body: { model: 'o3', reasoning_effort: 'high', stream: true } })
  })
})
