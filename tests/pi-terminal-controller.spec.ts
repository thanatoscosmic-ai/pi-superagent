import { Agent } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalController, type TerminalController, type TerminalEvent } from '../src/pi/terminal-controller.ts'
import type { AgentFactory, AgentOptions } from '../src/pi/types.ts'
import type { Assessment } from '../src/policy.ts'

const assessment: Assessment = {
  decision: 'accept', title: '修正文本', scope: '将 message.txt 改为 fixed', reason: '明确请求',
  direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: '指定 fixed' },
  rule_assessments: [{ rule_id: 'requested', matched: true, reason: '用户明确指定目标' }],
  intent_evidence: '修改文本', acknowledgement: '已接收请求',
}
const ready = () => [
  fauxAssistantMessage([fauxToolCall('write', { path: 'message.txt', content: 'fixed' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxToolCall('orchestrator_report', { state: 'ready', summary: '文本已修正' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(fauxText('完成')),
]
const waiting = () => [
  fauxAssistantMessage([fauxToolCall('orchestrator_report', { state: 'waiting', summary: '等待输入' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(fauxText('等待')),
]
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('缺少测试预期值')
  return value
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

async function setup(config?: unknown, configureAgent?: (agent: Agent) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pi-terminal-'))
  const cwd = join(root, 'repo')
  const stateDir = join(root, 'state')
  execFileSync('git', ['init', '-q', cwd])
  writeFileSync(join(cwd, 'message.txt'), 'old')
  execFileSync('git', ['-C', cwd, 'add', '.'])
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'])
  const provider = registerFauxProvider()
  provider.setResponses(ready())
  const loaded: AgentOptions[] = []
  const agents: Agent[] = []
  const factory: AgentFactory = options => {
    loaded.push(options)
    const agent = new Agent({ initialState: { ...options, model: provider.getModel(), thinkingLevel: 'off' }, streamFn: streamSimple })
    agents.push(agent)
    configureAgent?.(agent)
    return agent
  }
  const assess = vi.fn(async () => assessment)
  const controllers: TerminalController[] = []
  const events: TerminalEvent[] = []
  cleanups.push(async () => { for (const controller of controllers) await controller.close(); provider.unregister(); rmSync(root, { recursive: true, force: true }) })
  const open = async (resume = false, allowShell = false) => {
    const controller = await createTerminalController({ cwd, stateDir, config, assess, agentFactory: factory, resume, allowShell })
    controllers.push(controller)
    controller.subscribe(event => events.push(event))
    return controller
  }
  const controller = await open()
  const query = (sql: string) => {
    const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
    try { return db.prepare(sql).all() } finally { db.close() }
  }
  const settled = async (timeout = 10_000) => {
    await vi.waitFor(() => {
      const value = required(controllers.at(-1)).snapshot()
      expect(value.evaluating + value.queued + value.pendingReplies + value.running).toBe(0)
      expect(query('SELECT * FROM effect')).toHaveLength(0)
      expect(agents.every(agent => !agent.state.isStreaming)).toBe(true)
    }, { timeout, interval: 20 })
  }
  return { root, cwd, stateDir, provider, loaded, agents, assess, controller, events, open, query, settled }
}

describe('TerminalController 真实领域运行', () => {
  it('评估、授权、隔离执行、显式 report 与 reply，并隔离监听器异常和变更', async () => {
    const h = await setup()
    const stdout = vi.spyOn(process.stdout, 'write')
    h.controller.subscribe(() => { throw new Error('坏 listener') })
    h.controller.subscribe(async () => { throw new Error('异步坏 listener') })
    h.controller.subscribe(event => { if (event.type === 'snapshot') event.value.tickets.length = 0 })
    await h.controller.submit('把 message.txt 改为 fixed')
    await h.settled()
    const value = h.controller.snapshot()
    const ticket = required(value.tickets[0])
    expect(h.assess).toHaveBeenCalledOnce()
    expect(ticket.mandate).toMatchObject({ strength: 'explicit', actor: { source: 'local', id: 'operator' }, scope: assessment.scope })
    expect(ticket.ended?.outcome).toBe('completed')
    expect(ticket.assignments.at(-1)?.report?.state).toBe('ready')
    expect(readFileSync(join(required(ticket.execution).directory, 'message.txt'), 'utf8')).toBe('fixed')
    expect(readFileSync(join(h.cwd, 'message.txt'), 'utf8')).toBe('old')
    expect(value).toMatchObject({ mode: 'tickets', shell: false, evaluating: 0, queued: 0, pendingReplies: 0, running: 0, attention: 0 })
    expect(value.health.runtime?.state).toBe('ready')
    expect(h.events.some(event => event.type === 'domain')).toBe(true)
    expect(h.events.some(event => event.type === 'agent' && event.ticketId === ticket.id)).toBe(true)
    expect(h.events.some(event => event.type === 'reply' && event.text === '文本已修正')).toBe(true)
    expect(h.query("SELECT value FROM outbox").every(row => JSON.parse(String(row.value)).status === 'sent')).toBe(true)
    expect(JSON.parse(String(await h.controller.command(`/ticket ${ticket.id}`))).id).toBe(ticket.id)
    expect(JSON.parse(String(await h.controller.command('/tickets')))[0].report.state).toBe('ready')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('pause 保留队列，resume 真实执行，同 thread followup 不重新评估，new 新 thread', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.command('/pause')
    await h.controller.submit('修改 message.txt')
    expect(h.controller.snapshot()).toMatchObject({ paused: true, queued: 1, tickets: [] })
    await expect(h.controller.command('/mode coding')).rejects.toThrow('idle')
    await h.controller.command('/resume')
    await h.settled()
    const first = required(h.controller.snapshot().tickets[0])
    expect(h.controller.snapshot().running).toBe(0)
    h.provider.setResponses(waiting())
    await h.controller.submit('补充同一个修改的要求')
    expect(h.controller.snapshot().tickets[0]?.inputs.some(input => input.kind === 'trigger' && input.triggerId !== first.origin.triggerId)).toBe(true)
    await h.settled()
    expect(h.assess).toHaveBeenCalledTimes(2)
    expect(h.controller.snapshot().tickets[0]?.mandate).toEqual(first.mandate)
    const rows = h.query('SELECT value FROM trigger').map(row => JSON.parse(String(row.value)))
    expect(new Set(rows.map(row => row.channel.thread)).size).toBe(1)
    await h.controller.command('/new')
    h.provider.setResponses(ready())
    await h.controller.submit('另一个明确修改')
    await h.settled()
    expect(h.assess).toHaveBeenCalledTimes(3)
    expect(h.controller.snapshot().tickets).toHaveLength(2)
    expect(h.query('SELECT * FROM thread')).toHaveLength(2)
  })

  it('运行中 followup 尽快投递，禁止模式和 shell toggle，interrupt 真正暂停并恢复', async () => {
    let entered = false
    let released = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = await setup(undefined, agent => {
      vi.spyOn(agent, 'followUp')
      agent.prepareRequest = async (_request, signal) => {
        entered = true
        await new Promise<void>(resolve => {
          const abort = () => { signal?.removeEventListener('abort', abort); resolve() }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted || released) abort()
          else void gate.then(abort)
        })
      }
    })
    h.provider.setResponses(waiting())
    await h.controller.submit('修改文件')
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 })
    await h.controller.submit('继续补充')
    await vi.waitFor(() => expect(h.agents[0]?.followUp).toHaveBeenCalled(), { timeout: 5000 })
    expect(h.assess).toHaveBeenCalledOnce()
    await expect(h.controller.command('/shell on')).rejects.toThrow('idle')
    await expect(h.controller.command('/mode coding')).rejects.toThrow('idle')
    await h.controller.interrupt()
    expect(h.controller.snapshot().paused).toBe(true)
    expect(h.agents[0]?.signal?.aborted).toBe(true)
    released = true
    release()
    await h.controller.command('/resume')
    await h.settled()
    expect(h.query('SELECT * FROM trigger')).toHaveLength(2)
  })

  it('超范围请求由 trigger_handback 交还 core 评估且不扩大原 Mandate', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.submit('修改文件')
    await h.settled()
    const first = required(h.controller.snapshot().tickets[0])
    await h.controller.command('/pause')
    await h.controller.submit('另一个超范围任务')
    const triggers = h.query('SELECT value FROM trigger ORDER BY rowid').map(row => JSON.parse(String(row.value)))
    const followup = required(triggers.at(-1))
    h.provider.setResponses([
      fauxAssistantMessage([fauxToolCall('trigger_handback', { triggerId: followup.id, reason: '超出文本修改范围' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('已交还')),
      ...waiting(),
    ])
    await h.controller.command('/resume')
    await h.settled()
    expect(h.assess).toHaveBeenCalledTimes(2)
    const disposition = h.query('SELECT value FROM disposition').map(row => JSON.parse(String(row.value))).find(row => row.handbacks?.length)
    expect(disposition.handbacks[0].ticketId).toBe(first.id)
    expect(h.controller.snapshot().tickets.find(ticket => ticket.id === first.id)?.mandate).toEqual(first.mandate)
  })

  it('显式 config 不增补权限，评估 unavailable 可见，不创建虚假工单', async () => {
    const h = await setup({ policy: { sources: { local: { allowed: [] } } } })
    await h.controller.submit('修改文件')
    await h.settled()
    expect(h.assess).not.toHaveBeenCalled()
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    expect(h.query('SELECT value FROM decision').some(row => JSON.parse(String(row.value)).kind === 'ignore')).toBe(true)
  })

  it('暂停时闲聊仍被回答，工单调度与授权冻结', async () => {
    const h = await setup()
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '闲聊' })
    h.provider.setResponses([fauxAssistantMessage('我在。'), fauxAssistantMessage('排队中')])
    await h.controller.command('/pause')
    await h.controller.submit('hi')
    await h.settled()
    expect(h.events.some(event => event.type === 'agent' && event.ticketId === 'dialogue' &&
      event.value.type === 'message_end' && JSON.stringify(event.value.message.content).includes('我在。'))).toBe(true)
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    // A work request while paused waits for the resume instead of being authorized.
    h.assess.mockResolvedValue(assessment)
    await h.controller.submit('把 message.txt 改成 fixed')
    // 暂停中被排队的请求就是这个暂停的产物，不需要等它结束。
    await vi.waitFor(() => expect(h.controller.snapshot().queued).toBe(1))
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    h.provider.setResponses(ready())
    await h.controller.command('/resume')
    await h.settled()
    expect(h.controller.snapshot().tickets).toHaveLength(1)
  })

  it('工作请求只评估一次，闲聊不产生 Trigger 或 Decision', async () => {
    const h = await setup()
    await h.controller.submit('把 message.txt 改成 fixed')
    await h.settled()
    expect(h.assess).toHaveBeenCalledOnce()
    expect(h.controller.snapshot().tickets).toHaveLength(1)
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '闲聊' })
    h.provider.setResponses([fauxAssistantMessage('在的')])
    await h.controller.submit('你好')
    await h.settled()
    expect(h.assess).toHaveBeenCalledTimes(2)
    expect(h.query('SELECT * FROM trigger')).toHaveLength(1)
  })

  it('hi 和 nihao 连续评估 ignore 后真实对话，无工具无工单，resume 保留脱敏上下文和 processed', async () => {
    const h = await setup()
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '普通问候，不请求实施' })
    vi.stubEnv('TERMINAL_DIALOGUE_SECRET', 'dialogue-secret-729')
    h.controller.subscribe(() => { throw new Error('坏 dialogue listener') })
    h.controller.subscribe(async () => { throw new Error('异步坏 dialogue listener') })
    const responses = () => h.events.flatMap(event => event.type === 'agent' && event.ticketId === 'dialogue'
      && event.value.type === 'message_end' && event.value.message.role === 'assistant'
      ? [event.value.message.content.filter(part => part.type === 'text').map(part => part.text).join('')] : [])
    h.provider.setResponses([fauxAssistantMessage('你好！dialogue-secret-729')])
    await h.controller.submit('hi')
    await h.settled()
    h.provider.setResponses([fauxAssistantMessage('你好，有什么问题？')])
    await h.controller.submit('nihao')
    await h.settled()
    expect(responses()).toEqual(['你好！dialogue-secret-729', '你好，有什么问题？'])
    expect(h.assess).toHaveBeenCalledTimes(2)
    expect(h.loaded).toHaveLength(2)
    // 对话通道只读：能看代码，不能改代码、不能跑命令。
    const names = h.loaded.flatMap(options => options.tools?.map(tool => tool.name) ?? [])
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(name => ['read', 'glob', 'grep'].includes(name))).toBe(true)
    expect(h.loaded[1]?.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('hi'))).toBe(true)
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    // 闲聊不经过领域：没有 Trigger、没有 Decision、没有回写。
    expect(h.query('SELECT * FROM trigger')).toHaveLength(0)
    expect(h.query('SELECT * FROM decision')).toHaveLength(0)
    expect(h.query('SELECT * FROM outbox')).toHaveLength(0)
    expect(h.events.some(event => event.type === 'reply')).toBe(false)
    expect(readFileSync(join(h.cwd, 'message.txt'), 'utf8')).toBe('old')
    const row = required(h.query('SELECT * FROM pi_terminal_dialogue')[0])
    expect(String(row.messages)).not.toContain('dialogue-secret-729')
    expect(String(row.messages)).toContain('[凭据已隐藏]')
    expect(JSON.parse(String(row.processed))).toHaveLength(2)
    expect(h.controller.snapshot().health.dialogue).toMatchObject({ state: 'ignore', detail: '普通问候，不请求实施' })
    await h.controller.close()
    const resumed = await h.open(true)
    h.provider.setResponses([fauxAssistantMessage('上下文仍在')])
    await resumed.submit('继续对话')
    await h.settled()
    expect(h.loaded.at(-1)?.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('nihao'))).toBe(true)
    expect(JSON.parse(String(h.query('SELECT processed FROM pi_terminal_dialogue')[0]?.processed))).toHaveLength(3)
    expect(h.query('SELECT * FROM trigger')).toHaveLength(0)
  })

  it('目标未确定或规则不匹配的实施请求保持 gate，dialogue 解释和澄清不 write', async () => {
    const h = await setup()
    h.assess.mockResolvedValueOnce({ ...assessment, direction: { implementation_requested: true, target_basis: 'undetermined', requires_design_decision: true, evidence: '未指定目标' } })
    h.provider.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'message.txt', content: 'forbidden' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('目标尚未确定，未执行修改。你希望 message.txt 改成什么内容？'),
    ])
    await h.controller.submit('帮我把项目改好')
    await h.settled()
    expect(h.loaded[0]?.tools?.every(tool => ['read', 'glob', 'grep'].includes(tool.name))).toBe(true)
    expect(h.loaded[0]?.systemPrompt).toContain('directionUnsettled')
    expect(h.loaded[0]?.systemPrompt).toContain('一个澄清问题')
    expect(h.loaded[0]?.systemPrompt).toContain('ignore 不代表允许执行')
    expect(h.events.some(event => event.type === 'agent' && event.ticketId === 'dialogue' && event.value.type === 'tool_execution_end' && event.value.isError)).toBe(true)
    expect(h.events.some(event => event.type === 'agent' && event.value.type === 'message_end' && event.value.message.role === 'assistant'
      && JSON.stringify(event.value.message.content).includes('你希望 message.txt'))).toBe(true)
    expect(readFileSync(join(h.cwd, 'message.txt'), 'utf8')).toBe('old')
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    h.assess.mockResolvedValueOnce({ ...assessment, rule_assessments: [{ rule_id: 'requested', matched: false, reason: '不匹配规则' }] })
    h.provider.setResponses([fauxAssistantMessage('请求不匹配当前规则，未执行。你希望实施的具体目标和范围是什么？')])
    await h.controller.submit('再做一个修改')
    await h.settled()
    expect(h.loaded.at(-1)?.systemPrompt).toContain('noRuleMatched')
    expect(h.loaded.at(-1)?.tools?.every(tool => ['read', 'glob', 'grep'].includes(tool.name))).toBe(true)
    expect(h.query('SELECT * FROM ticket')).toHaveLength(0)
    // A judged-insufficient request still becomes a Trigger: its Decision records why no work started.
    expect(h.query('SELECT * FROM trigger')).toHaveLength(2)
  })

  it('dialogue 串行队列独立于其他工单，busy、interrupt、pause、close 安全取消并落盘', async () => {
    let block = false
    let entered = 0
    const h = await setup(undefined, agent => {
      agent.prepareRequest = async (_request, signal) => {
        // Block the conversation turn only: it is the agent whose tools are all read-only.
        const observing = agent.state.tools.every(tool => ['read', 'glob', 'grep'].includes(tool.name))
        if (!block || !observing) return
        entered++
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    })
    h.provider.setResponses(waiting())
    await h.controller.submit('明确任务')
    await h.settled()
    const ticket = required(h.controller.snapshot().tickets[0])
    await h.controller.command('/new')
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '对话而非实施' })
    block = true
    await h.controller.submit('hi')
    await vi.waitFor(() => expect(entered).toBe(1))
    expect(h.controller.snapshot().running).toBe(1)
    await expect(h.controller.command('/mode coding')).rejects.toThrow('idle')
    await expect(h.controller.command('/shell on')).rejects.toThrow('idle')
    await expect(h.controller.command('/new')).rejects.toThrow('dialogue')
    await h.controller.submit('nihao')
    await vi.waitFor(() => expect(h.controller.snapshot().queued).toBe(1))
    expect(entered).toBe(1)
    await h.controller.interrupt()
    expect(h.agents[1]?.state.isStreaming).toBe(false)
    expect(h.controller.snapshot().paused).toBe(false)
    expect(h.controller.snapshot().tickets[0]?.mandate).toEqual(ticket.mandate)
    expect(h.controller.snapshot().tickets[0]?.ended).toBeUndefined()
    await h.controller.command('/resume')
    await vi.waitFor(() => expect(entered).toBe(2))
    await h.controller.command('/pause')
    expect(h.controller.snapshot()).toMatchObject({ paused: true, running: 0 })
    await h.controller.command('/resume')
    await h.controller.submit('关闭时对话')
    await vi.waitFor(() => expect(entered).toBe(3))
    await Promise.all([h.controller.close(), h.controller.close()])
    expect(h.agents.every(agent => !agent.state.isStreaming)).toBe(true)
    expect(String(h.query('SELECT messages FROM pi_terminal_dialogue')[0]?.messages)).toContain('关闭时对话')
    // 只有第一条是工作请求（进入领域）；其余是对话，不产生 Trigger。
    expect(h.query('SELECT * FROM trigger')).toHaveLength(1)
    expect(JSON.parse(String(h.query('SELECT processed FROM pi_terminal_dialogue')[0]?.processed))).toHaveLength(3)
  })

  it('dialogue 最多 4 turn，未知脚本工具不执行也不创建工单', async () => {
    const h = await setup()
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '不执行' })
    h.provider.setResponses(Array.from({ length: 12 }, (_, index) => fauxAssistantMessage([
      fauxToolCall('write', { path: 'message.txt', content: 'forbidden' }, { id: `write-${index}` }),
    ], { stopReason: 'toolUse' })))
    await h.controller.submit('未授权修改')
    await h.settled()
    expect(h.events.some(event => event.type === 'notice' && event.text.includes('8 turn'))).toBe(true)
    // 脚本写 6 次，但第 9 个 turn 之前就到达上限，实际执行的是上限前的次数。
    expect(h.events.filter(event => event.type === 'agent' && event.value.type === 'tool_execution_end').length).toBeGreaterThan(0)
    expect(h.loaded[0]?.tools?.every(tool => ['read', 'glob', 'grep'].includes(tool.name))).toBe(true)
    expect(readFileSync(join(h.cwd, 'message.txt'), 'utf8')).toBe('old')
    expect(h.query('SELECT * FROM ticket')).toHaveLength(0)
  })

  it('dialogue 30 秒超时取消并给可行动 notice，不伪造回复', async () => {
    let entered = false
    const h = await setup(undefined, agent => {
      agent.prepareRequest = async (_request, signal) => {
        entered = true
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    })
    h.assess.mockResolvedValue({ ...assessment, decision: 'ignore', reason: '普通问题' })
    vi.useFakeTimers()
    try {
      await h.controller.submit('一个问题')
      await vi.waitFor(() => expect(entered).toBe(true))
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(h.events.some(event => event.type === 'notice' && event.text.includes('30 秒') && event.text.includes('重新发送'))).toBe(true))
      expect(h.controller.snapshot().running).toBe(0)
      expect(h.events.some(event => event.type === 'reply')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('真实 failed attention notice，可 retry 和 stop', async () => {
    const h = await setup()
    h.provider.setResponses([
      fauxAssistantMessage(fauxText('模型失败'), { stopReason: 'error', errorMessage: '模型执行失败' }),
    ])
    await h.controller.submit('修改文件')
    await h.settled()
    const failed = required(h.controller.snapshot().tickets[0])
    expect(failed.assignments.at(-1)?.report?.state).toBe('failed')
    expect(h.controller.snapshot().attention).toBe(1)
    await vi.waitFor(() => expect(h.events.some(event => event.type === 'notice' && event.text.includes('failed'))).toBe(true), { timeout: 1500 })
    h.provider.setResponses(waiting())
    await h.controller.command(`/retry ${failed.id}`)
    await h.settled()
    expect(h.controller.snapshot().tickets[0]?.assignments).toHaveLength(2)
    await h.controller.command(`/stop ${failed.id}`)
    expect(h.controller.snapshot().tickets[0]?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
    expect(h.controller.snapshot().running).toBe(0)
    await expect(h.controller.command(`/retry ${failed.id}`)).rejects.toThrow()
  })

  it('删除运行中的工单：停止其执行、移除记录并保留工作目录，且不会重新排队', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.submit('修改文件')
    await h.settled()
    const ticket = required(h.controller.snapshot().tickets[0])
    const directory = required(ticket.execution).directory
    // 该工单仍处于运行中的 Assignment，是「执行中的工单」。
    expect(ticket.assignments.at(-1)?.state).toBe('running')
    const ended = vi.fn()
    h.controller.subscribe(event => { if (event.type === 'domain' && event.value.type === 'ticket.ended') ended() })
    const result = await h.controller.command(`/delete ${ticket.id}`)
    expect(String(result)).toContain('已删除工单')
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    expect(ended).toHaveBeenCalled()
    expect(existsSync(directory)).toBe(true)
    // 记录不再出现，消息也不会作为新工单回到评估。
    await h.settled()
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    expect(h.query('SELECT * FROM ticket')).toHaveLength(0)
    expect(await h.controller.command(`/ticket ${ticket.id}`).catch(error => String(error))).toContain('未知工单')
    // 它的 worker 已被丢弃，运行计数随之归零，而不是一直显示「执行中」。
    expect(h.controller.snapshot()).toMatchObject({ running: 0, tickets: [] })
    expect(h.query('SELECT * FROM pi_session')).toHaveLength(0)
  })

  it('coding 直接编辑、事件标记、JSON 脱敏，模式切换不结束等待工单', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.submit('修改文件')
    await h.settled()
    const ticket = required(h.controller.snapshot().tickets[0])
    vi.stubEnv('TERMINAL_TEST_SECRET', 'terminal-secret-729')
    await h.controller.command('/mode coding')
    h.provider.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'message.txt', content: 'coding' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('结果 terminal-secret-729')),
    ])
    await h.controller.submit('直接编辑 terminal-secret-729')
    await h.settled()
    await vi.waitFor(() => expect(h.query('SELECT * FROM pi_terminal_coding')).toHaveLength(1))
    expect(readFileSync(join(h.cwd, 'message.txt'), 'utf8')).toBe('coding')
    expect(h.loaded.at(-1)?.cwd).toBe(h.controller.snapshot().cwd)
    expect(h.loaded.at(-1)?.tools?.some(tool => tool.name === 'orchestrator_report')).toBe(false)
    expect(h.events.some(event => event.type === 'agent' && event.ticketId === 'coding')).toBe(true)
    const json = String(h.query('SELECT messages FROM pi_terminal_coding')[0]?.messages)
    expect(json).not.toContain('terminal-secret-729')
    expect(json).toContain('[凭据已隐藏]')
    expect(h.controller.snapshot()).toMatchObject({ mode: 'coding', running: 0 })
    expect(h.controller.snapshot().tickets[0]?.id).toBe(ticket.id)
    expect(h.controller.snapshot().tickets[0]?.ended).toBeUndefined()
    await h.controller.command('/mode tickets')
    expect(h.controller.snapshot().tickets[0]?.mandate).toEqual(ticket.mandate)
  })

  it('resume 保留线程及 coding 消息，不恢复 shell，新启动无 resume 新线程', async () => {
    const h = await setup()
    await h.controller.command('/shell on')
    await h.controller.command('/mode coding')
    h.provider.setResponses([fauxAssistantMessage('保存上下文')])
    await h.controller.submit('coding 会话')
    await h.settled()
    await h.controller.command('/mode tickets')
    const thread = h.query("SELECT value FROM pi_terminal_meta WHERE key = 'thread'")[0]?.value
    await h.controller.close()
    const resumed = await h.open(true)
    expect(resumed.snapshot().shell).toBe(false)
    expect(h.query("SELECT value FROM pi_terminal_meta WHERE key = 'thread'")[0]?.value).toBe(thread)
    await resumed.command('/mode coding')
    expect(h.loaded.at(-1)?.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('coding 会话'))).toBe(true)
    expect(h.loaded.at(-1)?.tools?.some(tool => tool.name === 'bash')).toBe(false)
    await resumed.close()
    const fresh = await h.open(false)
    expect(h.query("SELECT value FROM pi_terminal_meta WHERE key = 'thread'")[0]?.value).not.toBe(thread)
    expect(fresh.snapshot().shell).toBe(false)
  })

  it('shell 空闲重建工具而不授予历史工单新权限，新工单才获得 bash', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.submit('修改文件')
    await h.settled()
    await h.controller.command('/shell on')
    h.provider.setResponses(waiting())
    await h.controller.submit('继续旧工单')
    await h.settled()
    expect(h.loaded.at(-1)?.tools?.some(tool => tool.name === 'bash')).toBe(false)
    await h.controller.command('/new')
    h.provider.setResponses(waiting())
    await h.controller.submit('新工单')
    await h.settled()
    expect(h.loaded.at(-1)?.tools?.some(tool => tool.name === 'bash')).toBe(true)
    await h.controller.command('/shell off')
    await h.controller.command('/mode coding')
    expect(h.loaded.at(-1)?.tools?.some(tool => tool.name === 'bash')).toBe(false)
  })

  it('500ms snapshot，close 幂等停止计时并拒绝新输入', async () => {
    const h = await setup()
    const count = () => h.events.filter(event => event.type === 'snapshot').length
    await vi.waitFor(() => expect(count()).toBeGreaterThan(0), { timeout: 1500 })
    await Promise.all([h.controller.close(), h.controller.close()])
    const closedCount = count()
    await vi.waitFor(() => expect(h.controller.snapshot().mode).toBe('tickets'))
    expect(count()).toBe(closedCount)
    await expect(h.controller.submit('closed')).rejects.toThrow('关闭')
    await expect(h.controller.command('/help')).rejects.toThrow('关闭')
    await h.controller.command('/exit')
  })

  it('评估异常记录 unavailable，不产生授权或 worker', async () => {
    const h = await setup()
    h.assess.mockRejectedValueOnce(new Error('评估不可用'))
    await h.controller.submit('修改文件')
    await h.settled()
    expect(h.controller.snapshot().tickets).toHaveLength(0)
    expect(h.query('SELECT value FROM decision').some(row => JSON.parse(String(row.value)).kind === 'unavailable')).toBe(true)
    expect(h.loaded).toHaveLength(0)
    expect(h.events.some(event => event.type === 'notice' && event.text.includes('unavailable') && event.text.includes('凭据') && event.text.includes('重新发送'))).toBe(true)
    expect(h.events.some(event => event.type === 'reply' || event.type === 'agent')).toBe(false)
    expect(h.controller.snapshot().health.dialogue).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('结构化输出') })
  })

  it('coding 运行中 followup，interrupt 和 close 取消，暂停不丢历史消息', async () => {
    let entered = false
    const h = await setup(undefined, agent => {
      vi.spyOn(agent, 'abort')
      vi.spyOn(agent, 'followUp')
      agent.prepareRequest = async (_request, signal) => {
        entered = true
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    })
    await h.controller.command('/mode coding')
    await h.controller.submit('开始 coding')
    await vi.waitFor(() => expect(entered).toBe(true))
    await h.controller.submit('coding followup')
    expect(h.agents[0]?.followUp).toHaveBeenCalledOnce()
    await expect(h.controller.command('/mode tickets')).rejects.toThrow('idle')
    await expect(h.controller.command('/shell on')).rejects.toThrow('idle')
    await h.controller.interrupt()
    expect(h.agents[0]?.abort).toHaveBeenCalled()
    expect(h.query('SELECT messages FROM pi_terminal_coding')).toHaveLength(1)
    entered = false
    await h.controller.submit('再次 coding')
    await vi.waitFor(() => expect(entered).toBe(true))
    await h.controller.command('/pause')
    expect(h.controller.snapshot().paused).toBe(true)
    await expect(h.controller.submit('暂停期间 coding')).rejects.toThrow('暂停')
    await h.settled()
    await h.controller.command('/resume')
    entered = false
    await h.controller.submit('关闭时取消')
    await vi.waitFor(() => expect(entered).toBe(true))
    await h.controller.close()
    expect(h.agents[0]?.state.isStreaming).toBe(false)
    expect(String(h.query('SELECT messages FROM pi_terminal_coding')[0]?.messages)).toContain('关闭时取消')
  })

  it('快照 history 只含人与助手的真实对话，恢复后保留上下文', async () => {
    const h = await setup()
    h.provider.setResponses([fauxAssistantMessage(fauxText('第一轮回答')), fauxAssistantMessage(fauxText('第二轮回答'))])
    await h.controller.command('/mode coding')
    await h.controller.submit('第一轮问题')
    await h.settled()
    await h.controller.submit('第二轮问题')
    await h.settled()
    const history = required(h.controller.snapshot()).history
    expect(history.map(entry => [entry.role, entry.text])).toEqual([
      ['user', '第一轮问题'], ['assistant', '第一轮回答'], ['user', '第二轮问题'], ['assistant', '第二轮回答'],
    ])
    expect(new Set(history.map(entry => entry.key)).size).toBe(history.length)
    await h.controller.close()
    const resumed = await h.open(true)
    await resumed.command('/mode coding')
    expect(resumed.snapshot().history.map(entry => entry.text)).toEqual(history.map(entry => entry.text))
  })

  it('等待中的 Assignment 不冒充实际运行任务', async () => {
    const h = await setup()
    h.provider.setResponses(waiting())
    await h.controller.submit('等待后续说明')
    await h.settled()
    expect(h.controller.snapshot().tickets[0]?.assignments.at(-1)?.state).toBe('running')
    expect(h.controller.snapshot().running).toBe(0)
    expect(h.controller.snapshot().queued).toBe(0)
  })
  it('coding 100 turn 上限取消并 notice，不创建工单', async () => {
    const h = await setup()
    await h.controller.command('/mode coding')
    h.provider.setResponses(Array.from({ length: 105 }, (_, index) => fauxAssistantMessage([
      fauxToolCall('read', { path: 'message.txt' }, { id: `read-${index}` }),
    ], { stopReason: 'toolUse' })))
    await h.controller.submit('持续读取')
    await h.settled(90_000)
    expect(h.events.some(event => event.type === 'notice' && event.text.includes('100 turn'))).toBe(true)
    expect(h.events.filter(event => event.type === 'agent' && event.value.type === 'turn_start')).toHaveLength(101)
    expect(h.controller.snapshot().tickets).toHaveLength(0)
  }, 100_000)

  it('coding 30min 超时取消并 notice', async () => {
    let entered = false
    const h = await setup(undefined, agent => {
      agent.prepareRequest = async (_request, signal) => {
        entered = true
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    })
    await h.controller.command('/mode coding')
    vi.useFakeTimers()
    try {
      await h.controller.submit('超时 coding')
      await vi.waitFor(() => expect(entered).toBe(true))
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      await vi.waitFor(() => expect(h.events.some(event => event.type === 'notice' && event.text.includes('30 分钟'))).toBe(true))
      expect(h.agents[0]?.state.isStreaming).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('模型窗口无需先发消息即可显示，且随对话给出上下文占用', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'deepseek-chat')
    const h = await setup()
    // Before any request the footer still names the window; the agent that would report it does not exist yet.
    expect(h.controller.snapshot().usage.window).toBe(128000)
    await h.controller.submit('把 message.txt 改为 fixed')
    await h.settled()
    const { usage } = h.controller.snapshot()
    expect(usage.window).toBeGreaterThan(0)
    expect(usage.context).toBeGreaterThanOrEqual(0)
  })

  it('direct coding 可在非 Git 启动，切 tickets 验证仓库且不丢上下文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-terminal-direct-'))
    const provider = registerFauxProvider()
    provider.setResponses([fauxAssistantMessage('直接 coding')])
    const controller = await createTerminalController({ cwd: root, stateDir: join(root, 'state'), mode: 'coding',
      agentFactory: options => new Agent({ initialState: { ...options, model: provider.getModel() }, streamFn: streamSimple }) })
    cleanups.push(async () => { await controller.close(); provider.unregister(); rmSync(root, { recursive: true, force: true }) })
    expect(controller.snapshot().mode).toBe('coding')
    await expect(controller.command('/mode tickets')).rejects.toThrow('--direct')
    expect(controller.snapshot().mode).toBe('coding')
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('非 Git 明确提示 --direct 且不创建仓库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-terminal-nongit-'))
    cleanups.push(async () => { rmSync(root, { recursive: true, force: true }) })
    await expect(createTerminalController({ cwd: root, stateDir: join(root, 'state') })).rejects.toThrow('--direct')
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(existsSync(join(root, 'state'))).toBe(false)
  })
})
