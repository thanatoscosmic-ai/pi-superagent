import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCoding, type CodingOptions } from '../src/pi/coding.js'
import { createPiAgent, type PiModel, type PiStreamFn } from '../src/pi/model.js'

const model: PiModel = {
  id: 'offline', name: '离线', api: 'openai-completions', provider: 'openai', baseUrl: 'http://127.0.0.1', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
}

function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, errorMessage, timestamp: Date.now(),
  }
}

function response(value: AssistantMessage, chunks?: string[]): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: 'start', partial: value })
  for (const delta of chunks ?? value.content.filter(part => part.type === 'text').map(part => part.text)) {
    stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: value })
  }
  if (value.stopReason === 'error' || value.stopReason === 'aborted') stream.push({ type: 'error', reason: value.stopReason, error: value })
  else stream.push({ type: 'done', reason: value.stopReason as 'stop' | 'toolUse' | 'length', message: value })
  stream.end(value)
  return stream
}

let cwd: string
let sessionPath: string
let text: string
let writes: string[]
let output: Writable
let agents: Agent[]

function factory(streamFn: PiStreamFn): NonNullable<CodingOptions['agentFactory']> {
  return options => {
    const agent = createPiAgent({ ...options, model, streamFn })
    agents.push(agent)
    return agent
  }
}

function options(streamFn: PiStreamFn, extra: Partial<CodingOptions> = {}): CodingOptions {
  return { cwd, sessionPath, output, input: Readable.from(['开始\n']), agentFactory: factory(streamFn), ...extra }
}

const done: PiStreamFn = () => response(message([{ type: 'text', text: '完成' }]))

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-coding-')))
  sessionPath = join(cwd, 'session.json')
  text = ''
  writes = []
  agents = []
  output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); writes.push(chunk.toString()); callback() } })
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('OPENAI_BASE_URL', '')
  vi.stubEnv('OPENAI_MODEL', '')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(cwd, { recursive: true, force: true })
})

describe('当前项目编码核心', () => {
  it('管道 EOF 保留连续多行并延续上下文，不输出交互提示', async () => {
    const contexts: TranscriptContext[] = []
    const streamFn: PiStreamFn = (_model, context) => {
      contexts.push(structuredClone(context))
      return response(message([{ type: 'text', text: `回复${contexts.length}` }]))
    }
    await runCoding(options(streamFn, { input: Readable.from(['第一行\n第二行\n第三行\n']) }))
    expect(agents[0]).toBeInstanceOf(Agent)
    expect(contexts).toHaveLength(3)
    expect(contexts[2]?.messages.filter(item => item.role === 'user')).toHaveLength(3)
    expect(contexts[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: '回复1' }] })]))
    expect(text).toBe('回复1\n回复2\n回复3\n')
    expect(text).not.toContain('你>')
    expect(agents[0]?.state.tools.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'glob', 'grep'])
    expect(agents[0]?.state.systemPrompt).toContain('先读取相关代码')
    expect(agents[0]?.state.systemPrompt).toContain('完成后运行相关测试')
    expect(agents[0]?.state.systemPrompt).toContain('不要额外提交或推送')
  })

  it('/new 清空上下文并保存，/help /status /exit 不调用模型', async () => {
    const streamFn = vi.fn<PiStreamFn>(done)
    await runCoding(options(streamFn, { input: Readable.from(['旧问题\n/new\n新问题\n/help\n/status\n/exit\n不应执行\n']) }))
    expect(streamFn).toHaveBeenCalledTimes(2)
    const context = streamFn.mock.calls[1]?.[1]
    expect(context?.messages.filter(item => item.role === 'user')).toEqual([expect.objectContaining({ content: [{ type: 'text', text: '新问题' }] })])
    const saved = JSON.parse(await readFile(sessionPath, 'utf8'))
    expect(saved.messages.filter((item: { role: string }) => item.role === 'user')).toHaveLength(1)
    expect(text).toContain('上下文已清空')
    expect(text).toContain('消息数：2')
    expect(text).toContain('shell：关闭')
  })

  it('恢复验证目录、保留历史、用当前系统提示且不恢复 shell 授权', async () => {
    await runCoding(options(done, { prompt: '历史问题', allowShell: true }))
    const saved = JSON.parse(await readFile(sessionPath, 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['cwd', 'messages'])
    expect(saved.messages.every((item: { role: string }) => item.role !== 'system')).toBe(true)
    const streamFn = vi.fn<PiStreamFn>(done)
    await runCoding(options(streamFn, { resume: true, prompt: '后续问题' }))
    expect(streamFn.mock.calls[0]?.[1].messages.filter(item => item.role === 'user')).toHaveLength(2)
    expect(agents[1]?.state.systemPrompt).toContain('shell 默认关闭')
    expect(agents[1]?.state.tools.some(tool => tool.name === 'bash')).toBe(false)
    saved.cwd = join(cwd, '其他项目')
    await writeFile(sessionPath, JSON.stringify(saved))
    await expect(runCoding(options(done, { resume: true }))).rejects.toThrow('cwd 与当前工作目录不匹配')
    expect(agents).toHaveLength(2)
  })

  it('恢复时优先使用 Agent.setSystemPrompt（若版本提供）', async () => {
    await runCoding(options(done, { prompt: '历史' }))
    const setSystemPrompt = vi.fn()
    await runCoding(options(done, {
      resume: true, prompt: '继续', agentFactory: config => {
        const agent = createPiAgent({ ...config, model, streamFn: done })
        Object.assign(agent, { setSystemPrompt })
        return agent
      },
    }))
    expect(setSystemPrompt).toHaveBeenCalledOnce()
    expect(setSystemPrompt.mock.calls[0]?.[0]).toContain(cwd)
  })

  it('真实工具直接写当前 cwd 并输出中文开始和结束事件，message_end 已持久化', async () => {
    let calls = 0
    const streamFn: PiStreamFn = async () => {
      if (++calls === 1) {
        const saved = JSON.parse(await readFile(sessionPath, 'utf8'))
        expect(saved.messages).toHaveLength(1)
        return response(message([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'actual.txt', content: '当前项目内容' } }], 'toolUse'))
      }
      expect(await readFile(join(cwd, 'actual.txt'), 'utf8')).toBe('当前项目内容')
      const saved = JSON.parse(await readFile(sessionPath, 'utf8'))
      expect(saved.messages.at(-1).role).toBe('toolResult')
      return response(message([{ type: 'text', text: '已写入' }]))
    }
    await runCoding(options(streamFn))
    expect(calls).toBe(2)
    expect(text).toContain('工具开始：写入文件')
    expect(text).toContain('工具完成：写入文件')
    expect(await readdir(cwd)).toEqual(expect.arrayContaining(['actual.txt', 'session.json']))
    expect(await readdir(cwd)).not.toContain('work')
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(cwd)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('shell 默认关闭，明确开启非沙箱后添加工具，关闭移除工具', async () => {
    const tools: string[][] = []
    const streamFn: PiStreamFn = () => {
      tools.push(agents[0]?.state.tools.map(tool => tool.name) ?? [])
      return response(message([{ type: 'text', text: '完成' }]))
    }
    await runCoding(options(streamFn, { input: Readable.from(['默认\n/shell on\n已开启\n/shell off\n已关闭\n']) }))
    expect(tools[0]).not.toContain('bash')
    expect(tools[1]).toContain('bash')
    expect(tools[2]).not.toContain('bash')
    expect(text).toContain('命令执行非沙箱')
    expect(text).toContain('系统钥匙串和网络')
  })

  it('prompt print 只调用一次且仅输出最终 response，不读阻塞输入', async () => {
    let calls = 0
    const streamFn: PiStreamFn = () => response(++calls === 1
      ? message([{ type: 'text', text: '中间说明' }, { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'print.txt', content: '测试' } }], 'toolUse')
      : message([{ type: 'text', text: '最终结果' }]))
    const input = new PassThrough()
    await runCoding(options(streamFn, { prompt: '任务', print: true, input }))
    expect(writes).toEqual(['最终结果\n'])
    expect(calls).toBe(2)
    input.destroy()
  })

  it('print 管道多行合并为一次用户 prompt', async () => {
    const streamFn = vi.fn<PiStreamFn>(done)
    await runCoding(options(streamFn, { print: true, input: Readable.from(['第一\n第二\n第三\n']) }))
    expect(streamFn).toHaveBeenCalledOnce()
    expect(streamFn.mock.calls[0]?.[1].messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: '第一\n第二\n第三' }] })
    expect(writes).toEqual(['完成\n'])
  })

  it('Ctrl+C abort 当前 turn 后可以继续下一行，清理信号监听', async () => {
    let calls = 0
    const listeners = process.listenerCount('SIGINT')
    const streamFn: PiStreamFn = (_model, _context, config) => {
      if (++calls !== 1) return response(message([{ type: 'text', text: '下一轮完成' }]))
      const stream = new AssistantMessageEventStream()
      config?.signal?.addEventListener('abort', () => {
        const aborted = message([], 'aborted', '已取消')
        stream.push({ type: 'error', reason: 'aborted', error: aborted })
        stream.end(aborted)
      }, { once: true })
      setImmediate(() => process.emit('SIGINT'))
      return stream
    }
    await runCoding(options(streamFn, { input: Readable.from(['取消此轮\n继续下一轮\n']) }))
    expect(calls).toBe(2)
    expect(text).toContain('当前轮已取消')
    expect(text).toContain('下一轮完成')
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it('空闲 Ctrl+C 退出，不等待输入 EOF', async () => {
    const input = new PassThrough()
    const ready = Promise.withResolvers<void>()
    const specialOutput = new Writable({ write(chunk, _encoding, callback) {
      if (chunk.toString().includes('状态：空闲')) ready.resolve()
      callback()
    } })
    const task = runCoding(options(done, { input, output: specialOutput }))
    input.write('/status\n')
    await ready.promise
    process.emit('SIGINT')
    await task
    input.destroy()
  })

  it('会话及跨 text_delta 输出脱敏所有已知 env 秘密，不持久化 credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-key-123')
    vi.stubEnv('CUSTOM_SECRET', 's.e+c[r]et')
    const streamFn: PiStreamFn = () => {
      const value = message([{ type: 'text', text: '密钥 private-key-123 以及 s.e+c[r]et' }])
      Object.assign(value, { credentials: { apiKey: '未知额外凭据' } })
      return response(value, ['密钥 private-', 'key-123 以及 s.e+', 'c[r]et'])
    }
    await runCoding(options(streamFn, { prompt: '用户秘密 private-key-123 s.e+c[r]et' }))
    const raw = await readFile(sessionPath, 'utf8')
    for (const secret of ['private-key-123', 's.e+c[r]et', '未知额外凭据', 'credentials']) expect(raw).not.toContain(secret)
    expect(raw).toContain('[凭据已隐藏]')
    expect(text).toBe('密钥 [凭据已隐藏] 以及 [凭据已隐藏]\n')
    await runCoding(options(done, { resume: true, prompt: '安全恢复' }))
  })

  it('模型错误 throw 脱敏中文错误而不是静默成功', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'error-secret')
    const streamFn: PiStreamFn = () => response(message([], 'error', 'provider failed error-secret'))
    const task = runCoding(options(streamFn, { prompt: '失败', print: true }))
    await expect(task).rejects.toThrow('编码助手运行失败：provider failed [凭据已隐藏]')
    expect(text).toBe('')
    expect(await readFile(sessionPath, 'utf8')).not.toContain('error-secret')
  })

  it('拒绝会话文件及父目录 symlink，不改链接目标', async () => {
    const target = join(cwd, 'target.json')
    await writeFile(target, '原内容')
    await symlink(target, sessionPath)
    await expect(runCoding(options(done, { prompt: '测试' }))).rejects.toThrow('符号链接')
    expect(await readFile(target, 'utf8')).toBe('原内容')
    await symlink(cwd, join(cwd, 'linked'))
    await expect(runCoding(options(done, { sessionPath: join(cwd, 'linked', 'other.json') }))).rejects.toThrow('符号链接')
    expect(agents).toHaveLength(0)
  })

  it('拒绝恢复超大、非法 JSON 和结构错误文件', async () => {
    await writeFile(sessionPath, ' '.repeat(8 * 1024 * 1024 + 1))
    await expect(runCoding(options(done, { resume: true }))).rejects.toThrow('8 MiB')
    await writeFile(sessionPath, '{')
    await expect(runCoding(options(done, { resume: true }))).rejects.toThrow('会话 JSON 无效')
    await writeFile(sessionPath, JSON.stringify({ cwd, messages: [{ role: 'user', content: 123 }] }))
    await expect(runCoding(options(done, { resume: true }))).rejects.toThrow('结构无效')
    expect(agents).toHaveLength(0)
  })

  it('持续工具请求最多允许 100 次模型调用', async () => {
    let calls = 0
    const streamFn: PiStreamFn = () => response(message([{ type: 'toolCall', id: `read-${++calls}`, name: 'read', arguments: { path: 'missing.txt' } }], 'toolUse'))
    await expect(runCoding(options(streamFn, { prompt: '持续工作', print: true }))).rejects.toThrow('100 次模型调用')
    expect(calls).toBe(100)
  }, 60000)

  it('30 分钟超时会 abort 并 throw 中文限制', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ready = Promise.withResolvers<void>()
    const streamFn: PiStreamFn = (_model, _context, config) => {
      const stream = new AssistantMessageEventStream()
      config?.signal?.addEventListener('abort', () => {
        const aborted = message([], 'aborted', '超时')
        stream.push({ type: 'error', reason: 'aborted', error: aborted })
        stream.end(aborted)
      }, { once: true })
      ready.resolve()
      return stream
    }
    const task = runCoding(options(streamFn, { prompt: '超时', print: true }))
    const assertion = expect(task).rejects.toThrow('30 分钟')
    await ready.promise
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await assertion
  })
})
