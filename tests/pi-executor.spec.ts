import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, latestAssignment, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { PiExecutor } from '../src/pi/executor.ts'
import type { AgentFactory, RuntimeConfig } from '../src/pi/types.ts'

const git = promisify(execFile)
const model: Model<'openai-completions'> = {
  id: 'scripted', name: '离线脚本', api: 'openai-completions', provider: 'openai', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
function response(content: AssistantMessage['content'], error?: string): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: error ? 'error' : content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(error ? { errorMessage: error } : {}),
  }
  stream.push({ type: 'start', partial: message })
  if (error) stream.push({ type: 'error', reason: 'error', error: message })
  else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message })
  stream.end(message)
  return stream
}
function call(name: string, args: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments']): AssistantMessageEventStream {
  return response([{ type: 'toolCall', id: `call-${name}`, name, arguments: args }])
}
/**
 * An answer the output limit cut off: the model stopped mid-sentence and asked nothing of anyone. The output ends below the
 * model's own limit, which is how pi tells a truncated reply from one that merely reached its configured cap.
 */
function truncated(content: AssistantMessage['content'], usage?: { input: number; output: number }): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const input = usage?.input ?? 0
  const output = usage?.output ?? 0
  const message: AssistantMessage = {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: 'length',
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  stream.push({ type: 'start', partial: message })
  stream.push({ type: 'done', reason: 'length', message })
  stream.end(message)
  return stream
}
function trigger(id: string, thread = 'conversation'): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: thread }], actor: { source: 'chat', id: 'person' }, human: true,
    addressed: 'direct', at: new Date().toISOString(), text: `请求 ${id}`, meta: {}, channel: { source: 'chat', thread, address: {} } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let root: string
type TestHost = {
  store: Store
  effects: Effects
  executor: PiExecutor
  engine: Engine
  factory: ReturnType<typeof vi.fn<AgentFactory>>
  agents: Agent[]
  outbox: OutboundMessage[]
  accept: (id?: string, thread?: string) => Ticket
  config: RuntimeConfig
  setPaused: (value: boolean) => void
}
const hosts: TestHost[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-executor-'))
  const repository = join(root, 'repository')
  await mkdir(repository)
  await git('git', ['-C', repository, 'init'])
  await writeFile(join(repository, 'tracked.txt'), '原始内容')
  await git('git', ['-C', repository, 'add', 'tracked.txt'])
  await git('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  await mkdir(join(repository, 'node_modules'))
  await writeFile(join(repository, 'node_modules', 'private'), '依赖')
  await writeFile(join(repository, '.env'), 'SECRET=不可复制')
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) {
    await host.executor.shutdown()
    await host.effects.drain()
    host.store.close()
  }
  await rm(root, { recursive: true, force: true })
})

function harness(streamFn: StreamFn, overrides: Partial<RuntimeConfig> = {}) {
  const config: RuntimeConfig = { stateDir: join(root, 'state'), repositoryDirectory: join(root, 'repository'), ...overrides }
  const store = new Store(join(config.stateDir, 'store.sqlite'))
  const effects = new Effects(store, { claim: () => ({ set: () => {}, get: () => undefined, release: () => {} }) })
  const agents: Agent[] = []
  const factory = vi.fn<AgentFactory>(options => {
    const agent = new Agent({ initialState: { systemPrompt: options.systemPrompt, tools: options.tools, messages: options.messages, model }, streamFn, toolExecution: 'sequential' })
    agents.push(agent)
    return agent
  })
  let engine!: Engine
  let paused = false
  const setPaused = (value: boolean) => { paused = value }
  const executor = new PiExecutor({ store, effects, config, agentFactory: factory, engine: () => engine, paused: () => paused })
  const outbox: OutboundMessage[] = []
  let tick = 0
  engine = new Engine({ repo: store, executor, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
    emit: event => {
      if (event.type === 'ticket.ended') store.afterCommit(() => {
        const ticket = store.tickets.get(event.data.ticketId)
        if (ticket) config.onResult?.(ticket)
      })
    },
    now: () => new Date(Date.UTC(2026, 10, 3) + ++tick * 1000).toISOString(),
    policy: () => ({ version: 'v1', paused, evalTimeoutMs: 60000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
    scope: { scope: () => ({ listened: true, observed: true }) }, assessor: { request: () => {} },
    outbox: { send: message => { outbox.push(message) }, status: id => outbox.some(message => message.id === id) ? 'pending' : undefined, withdraw: () => {} },
  })
  const accept = (id = 'origin', thread = 'conversation') => {
    engine.receive(trigger(id, thread))
    const decision = engine.decide(id, { kind: 'accept', title: '修复工单', scope: '只修改 tracked.txt', reason: '明确请求' })
    return store.tickets.get(decision.ticketId!)!
  }
  const host = { store, effects, executor, engine, factory, agents, outbox, accept, config, setPaused }
  hosts.push(host)
  return host
}

describe('Pi 执行器', () => {
  it('同步准备且只排队启动，在真实隔离 worktree 执行，不复制依赖或秘密', async () => {
    const host = harness(() => response([{ type: 'text', text: '未报告完成' }]))
    const ticket = host.accept()
    expect(ticket.execution).toMatchObject({ directory: join(root, 'state', 'work', ticket.id), assignment: ticket.mandate.scope })
    expect(host.factory).not.toHaveBeenCalled()
    await expect(access(ticket.execution!.directory)).rejects.toThrow()
    host.effects.start()
    await host.executor.idle()
    expect(await readFile(join(ticket.execution!.directory, 'tracked.txt'), 'utf8')).toBe('原始内容')
    await expect(access(join(ticket.execution!.directory, 'node_modules'))).rejects.toThrow()
    await expect(access(join(ticket.execution!.directory, '.env'))).rejects.toThrow()
    const branch = await git('git', ['-C', ticket.execution!.directory, 'symbolic-ref', '--short', 'HEAD'])
    expect(branch.stdout.trim()).toBe(`pi-superagent/${ticket.id}`)
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report?.state).toBe('waiting')
    expect(host.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(host.store.db.prepare('SELECT messages FROM pi_session WHERE ticket_id = ?').get(ticket.id)?.messages).toContain('未报告完成')
  })

  it('ready 报告走领域核心与 result 回复，停止不会在报告工具内等待自身 idle', async () => {
    const onResult = vi.fn()
    const host = harness(() => call('orchestrator_report', { state: 'ready', summary: '修复已经验证' }), { onResult })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(host.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticket.id, ended: expect.objectContaining({ outcome: 'completed' }) }))
    expect(host.outbox).toContainEqual(expect.objectContaining({ ticketId: ticket.id, text: '修复已经验证', kind: 'reply' }))
    await expect(host.agents[0]!.state.tools.find(tool => tool.name === 'write')!.execute('late', { path: 'tracked.txt', content: '越权' })).rejects.toThrow('已停止')
  })

  it('waiting 问题发送 attention，模型错误报告 failed 而不自动 ready', async () => {
    let count = 0
    const host = harness(() => ++count === 1
      ? call('orchestrator_report', { state: 'waiting', summary: '等待说明', question: '请确认需求' })
      : response([{ type: 'text', text: '等待' }]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(host.store.tickets.get(ticket.id)?.attention?.question).toBe('请确认需求')
    expect(host.outbox).toContainEqual(expect.objectContaining({ text: '请确认需求' }))
    host.agents[0]!.streamFunction = () => response([], '离线模型失败')
    host.engine.note(ticket.id, '新上下文')
    await host.executor.idle()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: '离线模型失败' })
  })

  it('运行期间持久接收后续输入，只在实际模型请求读取时标记 inputsRead', async () => {
    const entered = deferred(), release = deferred()
    let turns = 0
    const seen: AgentMessage[][] = []
    const host = harness(async (_model, context) => {
      seen.push([...context.messages])
      if (++turns === 1) { entered.resolve(); await release.promise }
      return response([{ type: 'text', text: '等待下一步' }])
    })
    const ticket = host.accept()
    host.effects.start()
    await entered.promise
    host.engine.receive(trigger('followup'))
    await host.effects.idle('delivery')
    const input = host.store.tickets.get(ticket.id)!.inputs.find(item => item.kind === 'trigger' && item.triggerId === 'followup')!
    expect(input).toMatchObject({ readAt: null })
    expect(host.store.tickets.get(ticket.id)?.undelivered).not.toContain(input.id)
    expect(host.store.db.prepare('SELECT pending FROM pi_session WHERE ticket_id = ?').get(ticket.id)?.pending).toContain(input.id)
    release.resolve()
    await host.executor.idle()
    expect(host.factory).toHaveBeenCalledOnce()
    expect(host.store.tickets.get(ticket.id)!.inputs.find(item => item.id === input.id)).toMatchObject({ readAt: expect.any(String) })
    expect(seen.at(-1)!.some(message => JSON.stringify(message).includes('followup'))).toBe(true)
  })

  it('停止提交后 abort，工具不能继续写入，事务回滚不会中止执行', async () => {
    const entered = deferred()
    const host = harness(async (_model, _context, options) => {
      entered.resolve()
      await new Promise<void>(done => options?.signal?.addEventListener('abort', () => done(), { once: true }))
      return response([{ type: 'text', text: '已取消' }])
    })
    const ticket = host.accept()
    host.effects.start()
    await entered.promise
    const abort = vi.spyOn(host.agents[0]!, 'abort')
    expect(() => host.store.atomic(() => { host.engine.stopTicket(ticket.id); throw new Error('回滚') })).toThrow('回滚')
    expect(abort).not.toHaveBeenCalled()
    host.engine.stopTicket(ticket.id, '人员要求停止')
    await host.executor.idle()
    expect(abort).toHaveBeenCalled()
    expect(host.store.tickets.get(ticket.id)?.ended?.outcome).toBe('stopped')
  })

  it('恢复 settled running 会话时懒加载 agent，后续输入复用合法 worktree 和历史', async () => {
    const first = harness(() => response([{ type: 'text', text: '持久历史' }]))
    const ticket = first.accept()
    first.effects.start()
    await first.executor.idle()
    await first.executor.shutdown()
    await first.effects.drain()
    first.store.close()
    hosts.splice(hosts.indexOf(first), 1)
    const second = harness(() => response([{ type: 'text', text: '恢复后等待' }]))
    second.executor.resume()
    second.effects.start()
    await second.executor.idle()
    expect(second.factory).not.toHaveBeenCalled()
    second.engine.receive(trigger('after-restart'))
    await second.executor.idle()
    expect(second.store.tickets.get(ticket.id)?.delivery).toBeUndefined()
    expect(second.factory).toHaveBeenCalledOnce()
    expect(JSON.stringify(second.factory.mock.calls[0]![0].messages)).toContain('持久历史')
    expect(latestAssignment(second.store.tickets.get(ticket.id)!)?.id).toBe(latestAssignment(ticket)?.id)
  })

  it('拒绝已存在非 worktree 目录，准备失败可见且不启动 agent', async () => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    await mkdir(ticket.execution!.directory, { recursive: true })
    host.effects.start()
    await host.executor.idle()
    expect(host.factory).not.toHaveBeenCalled()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('合法 Git worktree') })
  })

  it('launch handler 不等待 prompt，并发上限是真实运行任务数', async () => {
    const release = deferred(), entered = deferred()
    let running = 0, maximum = 0
    const host = harness(async () => {
      running++
      maximum = Math.max(maximum, running)
      entered.resolve()
      await release.promise
      running--
      return response([])
    })
    host.store.saveSettings({ executor: { maxWorkers: 1 } })
    const first = host.accept('one', 'one')
    const second = host.accept('two', 'two')
    host.effects.start()
    await entered.promise
    await host.effects.idle('launch')
    expect(host.factory).toHaveBeenCalledOnce()
    expect(latestAssignment(host.store.tickets.get(first.id)!)?.state).toBe('running')
    expect(latestAssignment(host.store.tickets.get(second.id)!)?.state).toBe('pending')
    release.resolve()
    await host.executor.idle()
    host.executor.start(host.store.tickets.get(second.id)!, latestAssignment(host.store.tickets.get(second.id)!)!)
    await host.executor.idle()
    expect(maximum).toBe(1)
    expect(host.factory).toHaveBeenCalledTimes(2)
  })

  it('人员 followup 可以使用额外一个并发名额，但普通启动不能突破上限', async () => {
    const release = deferred(), entered = deferred(), bothEntered = deferred()
    let running = 0, maximum = 0
    const host = harness(async () => {
      running++
      maximum = Math.max(maximum, running)
      entered.resolve()
      if (running === 2) bothEntered.resolve()
      await release.promise
      running--
      return response([])
    })
    host.store.saveSettings({ executor: { maxWorkers: 1 } })
    host.accept('first', 'first')
    const second = host.accept('second', 'second')
    host.engine.receive(trigger('person-followup', 'second'))
    host.effects.start()
    await entered.promise
    await host.effects.idle('launch')
    expect(host.factory).toHaveBeenCalledTimes(2)
    expect(latestAssignment(host.store.tickets.get(second.id)!)?.state).toBe('running')
    await bothEntered.promise
    release.resolve()
    await host.executor.idle()
    expect(maximum).toBe(2)
  })

  it('shutdown 先取消执行再等待并持久落盘，restart 通过 assignmentInterrupted 重建未完成 assignment', async () => {
    const entered = deferred()
    const first = harness(async (_model, _context, options) => {
      entered.resolve()
      await new Promise<void>(done => options?.signal?.addEventListener('abort', () => done(), { once: true }))
      return response([{ type: 'text', text: '中断前历史' }])
    })
    const ticket = first.accept()
    first.effects.start()
    await entered.promise
    await first.executor.shutdown()
    const interrupted = first.store.tickets.get(ticket.id)!
    expect(latestAssignment(interrupted)?.report).toBeUndefined()
    expect(first.store.db.prepare('SELECT messages FROM pi_session WHERE ticket_id = ?').get(ticket.id)?.messages).toContain('中断前历史')
    await first.effects.drain()
    first.store.close()
    hosts.splice(hosts.indexOf(first), 1)
    const second = harness(() => response([{ type: 'text', text: '恢复执行' }]))
    const callback = vi.spyOn(second.engine, 'assignmentInterrupted')
    second.executor.resume()
    expect(callback).toHaveBeenCalledWith(ticket.id, latestAssignment(ticket)!.id)
    second.effects.start()
    await second.executor.idle()
    const restored = second.store.tickets.get(ticket.id)!
    expect(restored.assignments).toHaveLength(2)
    expect(restored.assignments[0]?.endedReason).toBe('hostRestarted')
    expect(latestAssignment(restored)?.report?.state).toBe('waiting')
    expect(JSON.stringify(second.factory.mock.calls[0]![0].messages)).toContain('中断前历史')
  })

  it('beforeToolCall 拒绝跨工单及目录越界', async () => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const agent = host.agents[0]!
    const message = agent.state.messages.find(item => item.role === 'assistant')! as AssistantMessage
    for (const args of [{ ticketId: 'another' }, { path: '../secret' }]) {
      const blocked = await agent.beforeToolCall!({ assistantMessage: message,
        toolCall: { type: 'toolCall', id: 'denied', name: 'write', arguments: {} }, args,
        context: { messages: agent.state.messages, tools: agent.state.tools } })
      expect(blocked).toMatchObject({ block: true, terminate: true })
    }
    expect(host.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  })

  it('回答因长度上限被截断时续一轮，不把沉默当成 waiting', async () => {
    const seen: string[] = []
    let calls = 0
    const host = harness(async (_model, context) => {
      seen.push(JSON.stringify(context.messages.at(-1)?.content ?? ''))
      if (++calls === 1) return truncated([{ type: 'text', text: '正在读取' }])
      return call('orchestrator_report', { state: 'ready', summary: '截断后继续并完成' })
    })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(host.factory).toHaveBeenCalledOnce()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('截断')
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report?.state).toBe('ready')
    expect(host.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('持续截断时报告 failed 并说明原因，而不是等待人员', async () => {
    const host = harness(() => truncated([{ type: 'text', text: '' }]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const report = latestAssignment(host.store.tickets.get(ticket.id)!)?.report
    expect(report).toMatchObject({ state: 'failed', summary: expect.stringContaining('被截断') })
    expect(host.factory.mock.calls.length).toBe(1)
  })

  it('上下文接近窗口上限导致的截断同样续一轮，仍失败时说明原因', async () => {
    const host = harness(() => truncated([{ type: 'text', text: '' }], { input: model.contextWindow, output: 1 }))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const report = latestAssignment(host.store.tickets.get(ticket.id)!)?.report
    expect(report).toMatchObject({ state: 'failed', summary: expect.stringContaining('压缩上下文后仍未完成') })
  })

  it('三十分钟超时取消并报告 failed', async () => {
    const entered = deferred()
    const host = harness(async (_model, _context, options) => {
      entered.resolve()
      await new Promise<void>(done => options?.signal?.addEventListener('abort', () => done(), { once: true }))
      return response([])
    })
    const ticket = host.accept()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    host.effects.start()
    await entered.promise
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await host.executor.idle()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('三十分钟') })
  })

  it('将 executor.model 原样传入 agentFactory 的 roleModel', async () => {
    const host = harness(() => response([]))
    const roleModel = { provider: 'openai', model: 'executor-model', reasoningEffort: 'high' }
    host.store.saveSettings({ executor: { model: roleModel } })
    host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(host.factory.mock.calls[0]![0].roleModel).toEqual(roleModel)
  })

  it.each([false, true])('明确拒绝非空 prepare 配置且不执行或自动重试（allowShell=%s）', async allowShell => {
    const host = harness(() => response([]), { allowShell })
    host.store.saveSettings({ executor: { prepare: 'touch prepare-marker' } })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(host.factory).not.toHaveBeenCalled()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('不支持非空 executor.prepare') })
    expect(host.effects.pending('launch')).toBe(false)
    await expect(access(join(ticket.execution!.directory, 'prepare-marker'))).rejects.toThrow()
    host.executor.resume()
    host.engine.receive(trigger('prepare-followup'))
    await host.executor.idle()
    expect(host.factory).not.toHaveBeenCalled()
    expect(host.effects.pending('launch')).toBe(false)
  })

  it('明确拒绝自定义 directory，并接受与默认根目录等价的配置', async () => {
    const host = harness(() => response([]))
    host.store.saveSettings({ executor: { directory: join(root, 'different') } })
    expect(() => host.accept('rejected')).toThrow('仅支持 stateDir/work')
    expect(host.store.tickets.list()).toHaveLength(0)
    host.store.saveSettings({ executor: { directory: join(root, 'state', 'work') } })
    const ticket = host.accept('allowed')
    host.effects.start()
    await host.executor.idle()
    expect(ticket.execution!.directory).toBe(join(root, 'state', 'work', ticket.id))
    expect(host.factory).toHaveBeenCalledOnce()
  })

  it('目录配置在接受后更改也显式 failed，不在错误目录启动', async () => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    host.store.saveSettings({ executor: { directory: join(root, 'different') } })
    host.effects.start()
    await host.executor.idle()
    expect(host.factory).not.toHaveBeenCalled()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('executor.directory') })
    expect(host.effects.pending('launch')).toBe(false)
  })

  it('模型错误在报告及 pi_session 落盘前隐藏环境凭据和敏感 URL', async () => {
    const secrets = {
      TEST_API_KEY: 'key-private-value', TEST_TOKEN: 'token-private-value', TEST_SECRET: 'secret-private-value',
      TEST_PASSWORD: 'password/private value', TEST_CREDENTIAL: 'credential-private-value',
    }
    for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value)
    const error = `模型失败 ${Object.values(secrets).join(' ')} ${encodeURIComponent(secrets.TEST_PASSWORD)} https://user:url-password@example.com/path?token=url-token#url-secret api_key=inline-key Bearer inline-bearer`
    const host = harness(() => response([{ type: 'text', text: error }], error))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const stored = String(host.store.db.prepare('SELECT messages FROM pi_session WHERE ticket_id = ?').get(ticket.id)?.messages)
    const summary = latestAssignment(host.store.tickets.get(ticket.id)!)!.report!.summary
    for (const value of [...Object.values(secrets), encodeURIComponent(secrets.TEST_PASSWORD), 'url-password', 'url-token', 'url-secret', 'inline-key', 'inline-bearer']) {
      expect(stored).not.toContain(value)
      expect(summary).not.toContain(value)
    }
    expect(summary).toContain('模型失败')
    expect(summary).toContain('[已隐藏]')
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report?.state).toBe('failed')
  })

  it('准备错误隐藏环境凭据及 URL，不泄露到领域报告', async () => {
    vi.stubEnv('TEST_SECRET', 'prepare-private-value')
    const host = harness(() => response([]))
    host.factory.mockImplementation(() => { throw new Error('准备失败 prepare-private-value https://user:private@example.com?password=url-private') })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const summary = latestAssignment(host.store.tickets.get(ticket.id)!)!.report!.summary
    expect(summary).toContain('执行准备失败')
    expect(summary).not.toContain('prepare-private-value')
    expect(summary).not.toContain('url-private')
  })

  it('PR 绑定拒绝 URL、伪造 GitHub remote 和其他工单的分支', async () => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const tool = host.agents[0]!.state.tools.find(tool => tool.name === 'thread_bind_own_pr')!
    await expect(tool.execute('url', { source: 'github', id: 'https://github.com/team/repo/pull/7' })).rejects.toThrow('拉取请求编号')
    await git('git', ['-C', ticket.execution!.directory, 'remote', 'add', 'origin', 'https://evil.example/github.com/team/repo.git'])
    await expect(tool.execute('remote', { source: 'github', id: '7' })).rejects.toThrow('无法确认当前 GitHub 仓库')
    await git('git', ['-C', ticket.execution!.directory, 'remote', 'set-url', 'origin', 'https://github.com/team/repo.git'])
    await git('git', ['-C', ticket.execution!.directory, 'checkout', '-b', 'other-ticket'])
    await expect(tool.execute('branch', { source: 'github', id: '7' })).rejects.toThrow('分支与工单不匹配')
    expect(host.store.tickets.get(ticket.id)?.follows).toBeUndefined()
  })

  it('PR 绑定核对 gh api 的源仓库和工单分支，成功时使用数字字符串线程 ID', async () => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    await git('git', ['-C', ticket.execution!.directory, 'remote', 'add', 'origin', 'https://github.com/team/repo.git'])
    const bin = join(root, 'bin')
    await mkdir(bin)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    const tool = host.agents[0]!.state.tools.find(tool => tool.name === 'thread_bind_own_pr')!
    const pull = { number: 7, state: 'open', base: { repo: { full_name: 'team/repo' } },
      head: { ref: `pi-superagent/${ticket.id}`, repo: { full_name: 'team/repo' } } }
    const script = async (data: unknown) => writeFile(join(bin, 'gh'), `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['api', 'repos/team/repo/pulls/7'])) process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(data))});\n`, { mode: 0o700 })
    for (const data of [
      { ...pull, head: { ...pull.head, ref: 'other-ticket' } },
      { ...pull, head: { ...pull.head, repo: { full_name: 'other/repo' } } },
      { ...pull, base: { repo: { full_name: 'other/repo' } } },
      { ...pull, state: 'closed' },
      { ...pull, number: 8 },
    ]) {
      await script(data)
      await expect(tool.execute('reject', { source: 'github', id: '7' })).rejects.toThrow('拒绝绑定')
      expect(host.store.tickets.get(ticket.id)?.follows).toBeUndefined()
    }
    await script(pull)
    await tool.execute('bind', { source: 'github', id: '7' })
    expect(host.store.tickets.get(ticket.id)?.follows).toEqual([{ thread: 'github:7', own: true }])
    expect(host.store.threads.get('github:7')?.ref).toEqual({ source: 'github', id: '7' })
  })

  it('运行中暂停不报告失败或 turnEnded，恢复复用会话并读完待输入', async () => {
    const entered = deferred()
    let calls = 0
    const host = harness(async (_model, _context, options) => {
      if (++calls === 1) {
        entered.resolve()
        await new Promise<void>(done => options?.signal?.addEventListener('abort', () => done(), { once: true }))
        return response([], '因暂停取消')
      }
      return call('orchestrator_report', { state: 'waiting', summary: '暂停恢复后等待' })
    }, { maxTurns: 2 })
    const ticket = host.accept()
    const report = vi.spyOn(host.engine, 'report')
    const ended = vi.spyOn(host.engine, 'turnEnded')
    host.effects.start()
    await entered.promise
    host.engine.receive(trigger('pending-pause'))
    await host.effects.idle('delivery')
    const before = host.store.tickets.get(ticket.id)!
    const input = before.inputs.find(input => input.kind === 'trigger' && input.triggerId === 'pending-pause')!
    expect(input).toMatchObject({ readAt: null })
    host.executor.pause()
    host.setPaused(true)
    await host.executor.idle()
    expect(report).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(host.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(host.store.tickets.get(ticket.id)?.mandate).toEqual(ticket.mandate)
    expect(String(host.store.db.prepare('SELECT pending FROM pi_session WHERE ticket_id = ?').get(ticket.id)?.pending)).toContain(input.id)
    host.setPaused(false)
    host.agents[0]!.streamFunction = () => response([{ type: 'text', text: '暂停恢复后等待' }])
    await host.executor.resumePaused()
    await host.executor.idle()
    const restored = host.store.tickets.get(ticket.id)!
    expect(restored.assignments).toHaveLength(2)
    expect(restored.mandate).toEqual(ticket.mandate)
    expect(latestAssignment(restored)?.report?.state).toBe('waiting')
    expect(restored.inputs.find(item => item.id === input.id)).toMatchObject({ readAt: expect.any(String) })
    expect(host.factory).toHaveBeenCalledOnce()
    expect(restored.delivery).toBeUndefined()
  })

  it('pause 标志在主线程尚未设置 host.paused 时也阻止取消被记为失败', async () => {
    const entered = deferred()
    const host = harness(async (_model, _context, options) => {
      entered.resolve()
      await new Promise<void>(done => options?.signal?.addEventListener('abort', () => done(), { once: true }))
      return response([], '取消执行')
    })
    const ticket = host.accept()
    host.effects.start()
    await entered.promise
    host.executor.pause()
    await host.executor.idle()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toBeUndefined()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.idleAt).toBeUndefined()
    expect(host.outbox).toHaveLength(0)
  })

  it('工具错误后的有效 waiting 报告清除粘性错误，结束时不覆盖成 failed', async () => {
    let calls = 0
    const host = harness(() => {
      if (++calls === 1) return call('read', { path: 'missing.txt' })
      if (calls === 2) return call('orchestrator_report', { state: 'waiting', summary: '已确认缺失文件，等待新输入' })
      return response([{ type: 'text', text: '等待' }])
    })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'waiting', summary: '已确认缺失文件，等待新输入' })
    expect(host.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  })

  it.each(['blocked', 'failed'] as const)('%s 报告无 question 时创建可行动问题并发送 attention', async state => {
    let calls = 0
    const host = harness(() => ++calls === 1 ? call('orchestrator_report', { state, summary: '需要补充权限' }) : response([]))
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const restored = host.store.tickets.get(ticket.id)!
    expect(latestAssignment(restored)?.report?.state).toBe(state)
    expect(restored.attention?.question).toContain('请补充所需信息')
    expect(host.outbox).toContainEqual(expect.objectContaining({ ticketId: ticket.id, text: restored.attention!.question, kind: 'reply' }))
  })

  it('host 准备失败也发送 attention，问题保留明确重试提示', async () => {
    const host = harness(() => response([]))
    host.store.saveSettings({ executor: { prepare: 'unsupported-command' } })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    const failed = host.store.tickets.get(ticket.id)!
    expect(latestAssignment(failed)?.report?.state).toBe('failed')
    expect(failed.attention?.question).toContain('executor.prepare')
    expect(failed.attention?.question).toContain('明确重试')
    expect(host.outbox).toContainEqual(expect.objectContaining({ ticketId: ticket.id, text: failed.attention!.question }))
    expect(host.effects.pending('launch')).toBe(false)
  })

  it.each([false, true])('恢复已有工单分支并保留提交，仅清理自身缺失 worktree 登记（登记已清理=%s）', async removed => {
    const host = harness(() => response([]))
    const ticket = host.accept()
    const repository = host.config.repositoryDirectory
    const directory = ticket.execution!.directory
    await mkdir(join(root, 'state', 'work'), { recursive: true })
    await git('git', ['-C', repository, 'worktree', 'add', '-b', `pi-superagent/${ticket.id}`, directory, 'HEAD'])
    await writeFile(join(directory, 'tracked.txt'), '工单已有提交')
    await git('git', ['-C', directory, 'add', 'tracked.txt'])
    await git('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'ticket-work'])
    const original = (await git('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim()
    const unrelated = join(root, 'unrelated-worktree')
    await git('git', ['-C', repository, 'worktree', 'add', '-b', 'unrelated', unrelated, 'HEAD'])
    await rm(unrelated, { recursive: true, force: true })
    if (removed) await git('git', ['-C', repository, 'worktree', 'remove', directory])
    else await rm(directory, { recursive: true, force: true })
    host.effects.start()
    await host.executor.idle()
    expect(host.factory).toHaveBeenCalledOnce()
    expect(await readFile(join(directory, 'tracked.txt'), 'utf8')).toBe('工单已有提交')
    expect((await git('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(original)
    expect((await git('git', ['-C', repository, 'worktree', 'list', '--porcelain'])).stdout).toContain('unrelated-worktree')
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report?.state).toBe('waiting')
  })

  it('限制 maxTurns 且失败，不允许无限工具循环', async () => {
    const host = harness(() => call('orchestrator_read', {}), { maxTurns: 2 })
    const ticket = host.accept()
    host.effects.start()
    await host.executor.idle()
    expect(latestAssignment(host.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('轮数达到上限') })
  })
})
