import { homedir } from 'node:os'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  Markdown,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth,
  type ProgramStatus,
} from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { TerminalController, TerminalEvent, TerminalSnapshot } from '../src/pi/terminal-types.ts'
import { runTerminal, type Terminal } from '../src/pi/tui.ts'

class FakeTerminal implements Terminal {
  columns = 100
  rows = 40
  kittyProtocolActive = false
  writes: string[] = []
  lifecycle: string[] = []
  onInput?: (data: string) => void
  onResize?: () => void
  stopped = false
  cursorVisible = true
  drainError?: Error

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput
    this.onResize = onResize
    this.lifecycle.push('start')
  }

  stop(): void {
    this.stopped = true
    this.onInput = undefined
    this.onResize = undefined
    this.lifecycle.push('stop')
  }

  restoreOnExit(before: string, after: string): void {
    this.write(before + after)
    this.showCursor()
  }

  async drainInput(): Promise<void> {
    this.lifecycle.push('drain')
    if (this.drainError) throw this.drainError
  }

  write(data: string): void { this.writes.push(data) }
  moveBy(lines: number): void { this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`) }
  hideCursor(): void { this.cursorVisible = false }
  showCursor(): void { this.cursorVisible = true }
  clearLine(): void { this.write('\x1b[2K') }
  clearFromCursor(): void { this.write('\x1b[J') }
  clearScreen(): void { this.write('\x1b[2J') }
  setTitle(title: string): void { this.write(title) }
  setProgress(active: boolean): void { this.lifecycle.push(`progress:${active}`) }
  setProgramStatus(status: ProgramStatus): void { this.lifecycle.push(`status:${status.state}`) }
  input(data: string): void { this.onInput?.(data) }
  enter(text: string): void {
    this.input(`\x1b[200~${text}\x1b[201~`)
    this.input('\r')
  }
  resize(columns: number, rows = this.rows): void {
    this.columns = columns
    this.rows = rows
    this.onResize?.()
  }
  get output(): string { return stripTerminalSequences(this.writes.join('')) }
}

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    mode: 'tickets', cwd: '/Users/zhangyahao/Desktop/projects/pi-superagent', model: 'offline-model',
    shell: false, paused: false, tickets: [], evaluating: 0, queued: 0, pendingReplies: 0,
    running: 0, attention: 0, health: {}, history: [],
    usage: { input: 0, output: 0, cacheRead: 0, total: 0, context: 0, window: 0 }, ...overrides,
  }
}

class FakeController implements TerminalController {
  value = snapshot()
  listeners = new Set<(event: TerminalEvent) => void>()
  script?: (text: string, controller: FakeController) => Promise<void>
  snapshot = vi.fn(() => this.value)
  submit = vi.fn(async (text: string) => { await this.script?.(text, this) })
  command = vi.fn(async (_text: string): Promise<string | void> => {})
  interrupt = vi.fn(async () => {})
  close = vi.fn(async () => {})
  subscribe = vi.fn((listener: (event: TerminalEvent) => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  })

  emit(event: TerminalEvent): void {
    if (event.type === 'snapshot') this.value = event.value
    for (const listener of this.listeners) listener(event)
  }

  agent(value: AgentEvent, ticketId = 'T1'): void {
    this.emit({ type: 'agent', ticketId, value })
  }
}

function assistant(text: string, timestamp = 1): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
    provider: 'openai', model: 'offline', stopReason: 'stop', timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

function ticket(id = 'T1', overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: '修复真实工单', decisionId: 'D1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'direct' },
      actor: { source: 'terminal', id: 'human' }, scope: '只修改 src/pi' },
    channels: [], assignments: [{ id: 'A1', state: 'ended', createdAt: 'now',
      report: { state: 'ready', summary: '历史完成报告', at: 'now' } }],
    inputs: [{ kind: 'text', id: 'I1', text: '历史用户消息', at: 'now' }], undelivered: [],
    createdAt: 'now', updatedAt: 'now', origin: { triggerId: 'trigger', triggerIds: ['trigger'] },
    execution: { name: 'worker', directory: '/tmp/worktree/T1', assignment: '实现并验证' }, ...overrides,
  }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function launch(controller = new FakeController(), terminal = new FakeTerminal(), initialPrompt?: string) {
  let screen: TuiMainScreen | undefined
  const start = TuiMainScreen.prototype.start
  vi.spyOn(TuiMainScreen.prototype, 'start').mockImplementation(function (this: TuiMainScreen) {
    screen = this
    start.call(this)
  })
  const session = runTerminal(controller, { terminal, initialPrompt })
  const render = () => {
    if (!screen) throw new Error('TUI 未启动')
    screen.renderNow(true)
    return screen.render(terminal.columns).map(stripTerminalSequences).join('\n')
  }
  const children = () => screen?.children ?? []
  return { controller, terminal, session, render, children, get screen() { return screen } }
}

async function exit(app: ReturnType<typeof launch>) {
  app.terminal.enter('/exit')
  await app.session
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('pi 组件终端', () => {
  it('问候界面紧凑，无原始领域、ignore、空工单和内部角色，保留澄清回答', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ cwd: `${homedir()}/projects/pi-superagent`, health: {
      dialogue: { state: 'ignore', detail: '无须执行工具' },
      source: { state: 'ready', detail: '六行健康详情\na\nb\nc\nd\ne' },
    } })
    const app = launch(controller)
    controller.emit({ type: 'notice', text: '决策 ignore：问候无需工单' })
    controller.emit({ type: 'domain', value: { type: 'eval.started', at: 'now', data: {
      evalId: 'eval-hidden', threadKey: 'thread-hidden', triggerIds: ['trigger-hidden'], strength: 'explicit',
    } } })
    controller.agent({ type: 'message_end', message: assistant('你好！有什么可以帮你？') }, 'dialogue')
    controller.agent({ type: 'message_end', message: { role: 'user', content: '{"internal":"worker-input"}', timestamp: 8 } })
    const empty = assistant('', 9)
    empty.content = [{ type: 'toolCall', id: 'empty-call', name: 'read', arguments: {} }]
    controller.agent({ type: 'message_start', message: empty })
    controller.agent({ type: 'message_end', message: empty })
    controller.agent({ type: 'agent_end', messages: [empty] })
    const text = app.render()
    expect(text).toContain('pi-superagent')
    expect(text).toContain('你好！有什么可以帮你？')
    expect(text).toContain('就绪')
    for (const hidden of ['ignore', '六行健康', 'eval-hidden', 'thread-hidden', 'worker-input', '当前 ticket', 'Agent', '你\n', '评估:0']) expect(text).not.toContain(hidden)
    expect(text.split('\n').length).toBeLessThanOrEqual(14)
    for (const width of [18, 40, 100]) {
      app.terminal.resize(width)
      const lines = app.screen?.render(width) ?? []
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
      expect(app.children()[0]?.render(width)).toHaveLength(2)
      expect(app.children().at(-1)?.render(width)).toHaveLength(2)
    }
    await exit(app)
  })

  it('调试回看仅最近50事件，关闭无JSON，重要事件只一行短id和标题', async () => {
    const controller = new FakeController()
    const id = 'abcdefgh-long-ticket-id'
    controller.value = snapshot({ tickets: [ticket(id, { assignments: [], inputs: [] })] })
    const app = launch(controller)
    for (let i = 0; i < 51; i++) controller.emit({ type: 'domain', value: { type: 'eval.started', at: 'now', data: {
      evalId: `cached-${String(i).padStart(3, '0')}`, threadKey: 'thread-cache', triggerIds: [], strength: 'explicit',
    } } })
    const history = app.children()[2]
    expect(history?.render(100)).toEqual([])
    app.terminal.enter('/debug on')
    expect(app.render()).not.toContain('cached-000')
    expect(app.render()).toContain('cached-001')
    expect(app.render()).toContain('cached-050')
    app.terminal.enter('/debug on')
    expect(app.render().match(/cached-050/g)).toHaveLength(1)
    app.terminal.enter('/debug off')
    for (const type of ['ticket.created', 'ticket.ended', 'thread.subscribed'] as const) {
      if (type === 'ticket.created') controller.emit({ type: 'domain', value: { type, at: 'now', data: { ticketId: id, decisionId: 'D1', strength: 'explicit' } } })
      else if (type === 'ticket.ended') controller.emit({ type: 'domain', value: { type, at: 'now', data: { ticketId: id, by: 'executor', outcome: 'completed' } } })
      else controller.emit({ type: 'domain', value: { type, at: 'now', data: { ticketId: id, threadKey: 'raw-thread' } } })
    }
    const text = app.render()
    expect(text).toContain('已创建工单 · 修复真实工单')
    for (const hidden of [id, 'cached-', 'raw-thread', 'decisionId', '已订阅线程']) expect(text).not.toContain(hidden)
    app.terminal.enter('/ticket')
    expect(app.render()).toContain('abcdefgh-long-ticket-id')
    expect(app.render()).toContain('范围')
    expect(app.render()).toContain('实现并验证')
    expect(controller.command).not.toHaveBeenCalled()
    await exit(app)
  })

  it('健康默认只显示异常一行，debug和status保留包括ignore与unavailable的完整详情', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ health: {
      dialogue: { state: 'ignore', detail: '正常忽略详情' },
      source: { state: 'ready', detail: '健康ready详情' },
      model: { state: 'error', detail: '模型错误\n第二行错误\n第三行错误' },
      executor: { state: 'unavailable', detail: '执行器不可用' },
      worker: { state: 'failed', detail: 'worker失败' },
    } })
    controller.command.mockImplementation(async text => text === '/mode coding' ? JSON.stringify(controller.value.health) : undefined)
    const app = launch(controller)
    expect(app.render()).toContain('model: error')
    expect(app.render()).toContain('unavailable')
    expect(app.render()).toContain('failed')
    expect(app.render()).not.toContain('健康ready详情')
    expect(app.render()).not.toContain('正常忽略详情')
    expect(app.children().at(-1)?.render(100)).toHaveLength(2)
    app.terminal.enter('/debug on')
    expect(app.render()).toContain('dialogue: ignore 正常忽略详情')
    expect(app.render()).toContain('source: ready 健康ready详情')
    expect(app.render()).toContain('执行器不可用')
    app.terminal.enter('/debug off')
    app.terminal.enter('/mode coding')
    await flush()
    expect(app.render()).toContain('第三行错误')
    expect(controller.command.mock.calls.map(call => call[0])).toEqual(['/mode coding'])
    await exit(app)
  })

  it('报告更新只恢复一次，工具折叠有上限且展开保留安全完整args', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket()] })
    const app = launch(controller)
    for (let i = 0; i < 5; i++) {
      const current = ticket()
      const report = current.assignments[0]?.report
      if (report) report.summary = `报告版本${i}`
      controller.emit({ type: 'snapshot', value: snapshot({ tickets: [current] }) })
    }
    expect(app.render().match(/报告版本4/g)).toHaveLength(1)
    controller.agent({ type: 'tool_execution_start', toolCallId: 'hidden-call-id', toolName: 'read', args: {
      path: 'src/pi/tui.ts', offset: 8, token: 'hidden-credential', injected: '\x1b]52;c;BAD_CLIPBOARD\x07',
    } })
    controller.agent({ type: 'tool_execution_end', toolCallId: 'hidden-call-id', toolName: 'read', result: '第一行\n第二行\n第三行', isError: false })
    for (const width of [18, 40, 100]) {
      app.terminal.resize(width)
      const history = app.children()[2]
      const card = history && 'children' in history ? (history.children as Array<{ render(width: number): string[] }>).at(-1) : undefined
      expect(card?.render(width).length).toBeLessThanOrEqual(6)
      expect(app.screen?.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    app.terminal.resize(100)
    expect(app.render()).toContain('read src/pi/tui.ts:8')
    expect(app.render()).toContain('src/pi/tui.ts')
    // 与 pi 一致：折叠的 read 不重复正文，展开后才显示。
    expect(app.render()).not.toContain('第一行')
    expect(app.render()).not.toContain('offset')
    app.terminal.enter('/tools expand')
    expect(app.render()).toContain('offset')
    expect(app.render()).toContain('第三行')
    expect(app.render()).not.toContain('hidden-credential')
    expect(app.render()).not.toContain('BAD_CLIPBOARD')
    expect(app.render()).not.toContain('hidden-call-id')
    await exit(app)
  })

  it('领域 threadKey 保持可读，只有凭据字段被隐藏', async () => {
    const app = launch()
    app.controller.emit({ type: 'domain', value: { type: 'eval.started', at: 'now', data: {
      evalId: 'eval-1', threadKey: 'local:thread-1', triggerIds: ['trigger-1'], strength: 'explicit',
    } } })
    app.controller.emit({ type: 'notice', text: '{"apiKey":"not-for-display","threadKey":"local:thread-2","policyVersion":"policy-1"}' })
    const screen = app.render()
    expect(screen).not.toContain('local:thread-1')
    app.terminal.enter('/debug on')
    expect(app.render()).toContain('local:thread-1')
    expect(app.render()).toContain('trigger-1')
    app.terminal.enter('/debug off')
    expect(app.render()).not.toContain('local:thread-1')
    expect(app.controller.command).not.toHaveBeenCalled()
    expect(screen).toContain('local:thread-2')
    expect(screen).toContain('policy-1')
    expect(screen).not.toContain('not-for-display')
    await exit(app)
  })

  it('使用真实 TuiMainScreen Markdown 多行 Editor，提交后 Ctrl+C 完整清理', async () => {
    const app = launch()
    expect(app.screen).toBeInstanceOf(TuiMainScreen)
    expect(app.screen?.children.some(child => child instanceof Editor)).toBe(true)
    app.terminal.input('第一行')
    app.terminal.input('\x1b[13;2u')
    app.terminal.input('第二行')
    app.terminal.input('\r')
    expect(app.render()).toContain('工作中')
    await flush()
    expect(app.controller.submit).toHaveBeenCalledWith('第一行\n第二行')
    const history = app.children()[2]
    expect(history && 'children' in history && (history.children as unknown[]).some(child => child instanceof Markdown)).toBe(true)
    // pi 语义：空闲时第一次 Ctrl+C 清空/提示，连按两次退出。
    app.terminal.input('\x03')
    app.terminal.input('\x03')
    await app.session
    expect(app.controller.close).toHaveBeenCalledTimes(1)
    expect(app.controller.listeners.size).toBe(0)
    expect(app.terminal.onInput).toBeUndefined()
    expect(app.terminal.onResize).toBeUndefined()
    expect(app.terminal.cursorVisible).toBe(true)
    expect(app.terminal.lifecycle.slice(-2)).toEqual(['drain', 'stop'])
    const count = app.terminal.writes.length
    app.controller.emit({ type: 'notice', text: '关闭后不可输出' })
    app.terminal.input('不可输入')
    await flush()
    expect(app.terminal.writes).toHaveLength(count)
  })

  it('串行提交跟进并允许忙时暂停、恢复和中断后继续', async () => {
    const gate = deferred()
    const controller = new FakeController()
    controller.script = async text => { if (text === '首次提交') await gate.promise }
    const app = launch(controller)
    app.terminal.enter('首次提交')
    await flush()
    app.terminal.enter('跟进提交')
    app.terminal.enter('/pause')
    await flush()
    expect(controller.submit.mock.calls.map(call => call[0])).toEqual(['首次提交'])
    expect(controller.command).toHaveBeenCalledWith('/pause')
    expect(app.render()).toContain('队列 1')
    app.terminal.input('\x03')
    await flush()
    expect(controller.interrupt).toHaveBeenCalledTimes(1)
    expect(controller.close).not.toHaveBeenCalled()
    gate.resolve()
    await flush()
    expect(controller.submit.mock.calls.map(call => call[0])).toEqual(['首次提交', '跟进提交'])
    app.terminal.enter('/resume')
    app.terminal.enter('中断后继续')
    await flush()
    expect(controller.submit).toHaveBeenLastCalledWith('中断后继续')
    await exit(app)
  })

  it('Ctrl+O 展开或折叠全部工具、Ctrl+D 仅在空编辑器退出', async () => {
    const app = launch()
    app.controller.agent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'x\ny\nz', isError: false })
    expect(app.render()).toContain('bash')
    app.terminal.input('\x0f')
    await flush()
    expect(app.render()).toContain('args:')
    app.terminal.input('\x0f')
    await flush()
    expect(app.render()).not.toContain('args:')
    app.terminal.input('草稿')
    app.terminal.input('\x04')
    await flush()
    expect(app.controller.close).not.toHaveBeenCalled()
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    editor.setText('')
    app.terminal.input('\x04')
    await app.session
    expect(app.controller.close).toHaveBeenCalledTimes(1)
  })

  it('暂停时提交的消息会提示已排队，而不是看起来没有回复', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ paused: true })
    const app = launch(controller)
    expect(app.render()).toContain('已暂停')
    app.terminal.enter('hi')
    await flush()
    expect(controller.submit).toHaveBeenCalledWith('hi')
    expect(app.render()).toContain('编码请求会排队')
    await exit(app)
  })

  it('恢复提示里的内部文本不作为用户消息显示', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket('T1', {
      inputs: [
        { kind: 'text', id: 'R1', text: 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing.', at: 'now' },
        { kind: 'text', id: 'S1', text: 'Report the current ticket status with orchestrator_report. This is a status-only request.', at: 'now' },
      ],
      assignments: [],
    })] })
    const app = launch(controller)
    const text = app.render()
    expect(text).not.toContain('The host restarted during this ticket')
    expect(text).not.toContain('Report the current ticket status')
    await exit(app)
  })

  it('暂停时显示静态暂停提示，Escape 不被忙状态卡住', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ running: 1, paused: true })
    const app = launch(controller)
    expect(app.render()).toContain('已暂停')
    expect(app.render()).not.toContain('工作中')
    expect(app.render()).not.toContain('评估中')
    app.terminal.input('\x1b')
    await app.session
    expect(controller.interrupt).not.toHaveBeenCalled()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it.each(['running', 'evaluating'] as const)('snapshot %s 忙时 Escape 中断不退出，闲时 Escape 退出', async field => {
    const controller = new FakeController()
    controller.value = snapshot({ [field]: 1 })
    controller.interrupt.mockImplementation(async () => { controller.emit({ type: 'snapshot', value: snapshot() }) })
    const app = launch(controller)
    app.terminal.input('\x1b')
    await flush()
    expect(controller.interrupt).toHaveBeenCalledTimes(1)
    expect(controller.close).not.toHaveBeenCalled()
    app.terminal.input('\x1b')
    await app.session
    // 空闲时 Escape 直接退出，不再请求中断。
    expect(controller.interrupt).toHaveBeenCalledTimes(1)
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(app.terminal.stopped).toBe(true)
  })

  it('恢复工单历史、详情、状态并转发全部命令', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket(), ticket('T2', { title: '第二工单' })], evaluating: 2,
      queued: 3, pendingReplies: 4, attention: 5, paused: true, shell: true,
      health: { source: { state: 'ready', detail: '本地健康' } } })
    controller.command.mockImplementation(async text => text === '/ticket T2' ? 'ticket T2 · 第二工单\nmandate: 完整授权\nassignment: 实现并验证' : undefined)
    const app = launch(controller)
    const text = app.render()
    for (const value of ['offline-model', '工单', '历史用户消息', '历史完成报告',
      '评估 2', '队列 3', '回写 4', '待办 5', 'shell 开', '已暂停']) expect(text).toContain(value)
    for (const value of ['mandate:', 'report:', '本地健康', 'assignment:']) expect(text).not.toContain(value)
    controller.emit({ type: 'snapshot', value: controller.value })
    // 同一份历史重放不会重复显示。
    expect(app.render().match(/历史用户消息/g)).toHaveLength(1)
    const inputs = ['/tickets', '/ticket T2', '/pause', '/resume', '/stop T1', '/retry T1',
      '/mode coding', '/mode tickets', '/shell on', '/shell off', '/new', '/help', '/status']
    for (const input of inputs) {
      app.terminal.enter(input)
      await flush()
    }
    expect(controller.command.mock.calls.map(call => call[0])).toEqual(inputs.filter(input => !['/tickets', '/ticket T2', '/status'].includes(input)))
    expect(app.render()).toContain('模式')
    expect(controller.submit).not.toHaveBeenCalled()
    await exit(app)
    expect(controller.command).toHaveBeenLastCalledWith('/exit')
  })

  it('/tickets 本地渲染列表且不转发 controller', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket()] })
    controller.command.mockImplementation(async text => {
      if (text === '/tickets') throw new Error('不应转发')
      if (text === '/help') return '唯一帮助内容'
    })
    const app = launch(controller)
    app.terminal.enter('/tickets')
    await flush()
    const text = app.render()
    expect(text).toContain('修复真实工单')
    expect(text).toContain('待处理')
    expect(text).not.toContain('不应转发')
    app.terminal.enter('/help')
    await flush()
    expect(app.render().match(/唯一帮助内容/g)).toHaveLength(1)
    expect(controller.command.mock.calls.map(call => call[0])).toEqual(['/help'])
    await exit(app)
  })

  it('显示完整和流式 assistant 消息，不重复 delta、message_end 或 agent_end', async () => {
    const app = launch()
    const endOnly = assistant('仅结束事件完整回复')
    app.controller.agent({ type: 'message_end', message: endOnly })
    expect(app.render()).toContain('仅结束事件完整回复')
    app.controller.agent({ type: 'message_end', message: endOnly })
    const start = assistant('', 2)
    app.controller.agent({ type: 'message_start', message: start })
    const first = assistant('流式第一段', 2)
    app.controller.agent({ type: 'message_update', message: first,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '流式第一段', partial: first } })
    expect(app.render()).toContain('流式第一段')
    const final = assistant('流式第一段第二段', 2)
    app.controller.agent({ type: 'message_update', message: final,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第二段', partial: final } })
    app.controller.agent({ type: 'message_end', message: final })
    app.controller.agent({ type: 'agent_end', messages: [endOnly, final] })
    const text = app.render()
    expect(text.match(/仅结束事件完整回复/g)).toHaveLength(1)
    expect(text.match(/流式第一段第二段/g)).toHaveLength(1)
    expect(text).not.toContain('流式第一段流式第一段')
    app.controller.emit({ type: 'reply', ticketId: 'T2', text: '**真实回写**' })
    app.controller.emit({ type: 'domain', value: { type: 'ticket.ended', at: 'now',
      data: { ticketId: 'T1', by: 'executor', outcome: 'completed' } } })
    expect(app.render()).toContain('真实回写')
    expect(app.render()).toContain('已结束工单')
    await exit(app)
  })

  it('工具卡显示运行、完成、失败，默认折叠、允许展开且输出有上限', async () => {
    const app = launch()
    app.controller.agent({ type: 'tool_execution_start', toolCallId: 'call1', toolName: 'read', args: { path: 'src/pi/tui.ts' } })
    expect(app.render()).toContain('read')
    expect(app.render()).toContain('src/pi/tui.ts')
    const output = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n' + `${'x'.repeat(80)}\n`.repeat(250) + 'OUTSIDE_LIMIT'
    app.controller.agent({ type: 'tool_execution_update', toolCallId: 'call1', toolName: 'read', args: {},
      partialResult: { content: [{ type: 'text', text: output }] } })
    expect(app.render()).not.toContain('args:')
    expect(app.render()).not.toContain('call1')
    expect(app.render()).not.toContain('line1')
    app.controller.agent({ type: 'tool_execution_end', toolCallId: 'call1', toolName: 'read',
      result: { content: [{ type: 'text', text: output }] }, isError: false })
    expect(app.render()).toContain('read')
    app.terminal.enter('/tools expand')
    await flush()
    expect(app.render()).toContain('line19')
    expect(app.render()).toContain('输出已截断')
    expect(app.render()).not.toContain('OUTSIDE_LIMIT')
    app.controller.agent({ type: 'tool_execution_end', toolCallId: 'call2', toolName: 'write', result: '磁盘失败', isError: true })
    expect(app.render()).toContain('write')
    expect(app.render()).toContain('磁盘失败')
    app.terminal.enter('/tools collapse')
    await flush()
    expect(app.render()).not.toContain('line19')
    await exit(app)
  })

  it('保留受控 SGR 主题和代码高亮，拒绝外部样式及 OSC 注入', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket()] })
    const app = launch(controller)
    controller.emit({ type: 'reply', text: '# 标题\n\n```ts\nconst answer = 42\nconst label = "中文"\n```\n\n\x1b[35m外部样式\x1b[0m\x1b]52;c;ATTACK\x07\n[safe](https://example.com)' })
    controller.agent({ type: 'tool_execution_end', toolCallId: 'success', toolName: 'read', result: 'ok', isError: false })
    controller.agent({ type: 'tool_execution_end', toolCallId: 'failure', toolName: 'write', result: 'failed', isError: true })
    app.render()
    const raw = app.screen?.render(100).join('\n') ?? ''
    expect(raw).toContain('\x1b[38;2;228;138;122m')
    expect(raw).toContain('\x1b[1mpi-superagent\x1b[22m')
    expect(raw).toContain('\x1b[48;2;37;65;49m')
    expect(raw).toContain('\x1b[48;2;91;40;42m')
    app.terminal.enter('/debug on')
    expect(app.screen?.render(100).join('\n')).toContain('调试')
    app.terminal.enter('/debug off')
    expect(raw).not.toContain('\x1b[35m')
    expect(raw).not.toContain('ATTACK')
    expect(raw).not.toContain('\x1b]')
    expect(raw.split(CURSOR_MARKER).join('')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b_pi:(?:fc|\/fc)\x07/g, '')).not.toContain('\x1b')
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    expect(editor.render(100).join('\n')).toContain('─')
    for (const width of [24, 40, 100]) {
      app.terminal.resize(width)
      expect(app.screen?.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    await exit(app)
  })

  it('/tools 仅本地处理，help 只显示 controller 返回内容一次', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket()] })
    controller.command.mockImplementation(async text => {
      if (text.startsWith('/tools')) throw new Error('未知 tools 命令')
      if (text === '/help') return '唯一帮助内容'
      if (text === '/tickets') return '唯一工单列表'
      if (text === '/status') throw new Error('不应转发 status')
    })
    const app = launch(controller)
    for (const input of ['/tools', '/tools expand', '/tools collapse', '/debug on', '/debug off', '/debug invalid', '/help', '/tickets', '/status']) {
      app.terminal.enter(input)
      await flush()
    }
    expect(controller.command.mock.calls.map(call => call[0])).toEqual(['/help'])
    const text = app.render()
    expect(text.match(/唯一帮助内容/g)).toHaveLength(1)
    expect(text).not.toContain('未知 tools 命令')
    expect(text).not.toContain('不应转发 status')
    expect(text).toContain('调度')
    expect(text).not.toContain('展开或折叠工具输出')
    await exit(app)
  })

  it('工具完整输出不被当作流式截断，也不丢最后字符', async () => {
    const app = launch()
    app.controller.agent({ type: 'tool_execution_end', toolCallId: 'g1', toolName: 'glob',
      result: { content: [{ type: 'text', text: 'src/a.ts\nsrc/b.ts' }] }, isError: false })
    const text = app.render()
    expect(text).toContain('src/a.ts')
    expect(text).toContain('src/b.ts')
    await exit(app)
  })

  it('所有外部数据去除终端注入和已知 secret，包括跨 delta、宽度换行和 Editor', async () => {
    const secret = 'VERY_PRIVATE_SECRET_VALUE_123456789'
    vi.stubEnv('PI_TEST_API_KEY', secret)
    const attack = `\x1b]52;c;INJECTED_CLIPBOARD\x07\x1b[31m${secret}\x1b[0m\x07\x9d52;c;C1_INJECTION\x9c`
    const controller = new FakeController()
    controller.value = snapshot({ model: attack, health: { [attack]: { state: attack, detail: attack } },
      tickets: [ticket(attack, { title: attack })] })
    const app = launch(controller)
    app.terminal.resize(24)
    controller.emit({ type: 'notice', text: attack })
    controller.emit({ type: 'reply', text: `[safe](${attack})` })
    controller.agent({ type: 'tool_execution_start', toolCallId: attack, toolName: attack, args: { path: attack } })
    controller.agent({ type: 'tool_execution_end', toolCallId: attack, toolName: attack, result: attack, isError: true })
    const first = assistant(`开始 ${secret.slice(0, 20)}`, 3)
    controller.agent({ type: 'message_update', message: first,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: first.content[0]?.type === 'text' ? first.content[0].text : '', partial: first } })
    expect(app.render()).not.toContain(secret.slice(0, 20))
    const last = assistant(`开始 ${secret}`, 3)
    controller.agent({ type: 'message_end', message: last })
    app.terminal.input(`\x1b[200~${secret}\x1b[201~`)
    app.render()
    for (const value of [secret, secret.slice(0, 20), 'INJECTED_CLIPBOARD', 'C1_INJECTION', '\x1b]52;', '\x9d']) {
      expect(app.terminal.writes.join('')).not.toContain(value)
    }
    expect(app.terminal.output).toContain('凭据已隐藏')
    app.terminal.input('\r')
    await flush()
    expect(controller.submit).toHaveBeenCalledWith(secret)
    await exit(app)
  })

  it('resize、宽字符和 CJK Markdown 表格使用 pi 的宽度渲染', async () => {
    const app = launch()
    app.controller.emit({ type: 'reply', text: '# 中文标题\n\n| 路径 | 状态 |\n| --- | --- |\n| 超长中文路径测试测试测试 | 完成 |\n\n全角ＡＢＣ 日本語 한국어' })
    for (const width of [120, 40, 18, 80]) {
      app.terminal.resize(width, 18)
      await flush()
      const lines = app.screen?.render(width) ?? []
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
      expect(app.render()).toContain('中文标题')
    }
    await exit(app)
  })

  it('输入框保留光标，脚注显示上下文占用百分比', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ model: 'test-model',
      usage: { input: 1000, output: 200, cacheRead: 0, total: 1200, context: 64000, window: 128000 } })
    const app = launch(controller)
    // 光标是 TUI 的协议序列，不能被脱敏器当成注入剥掉。
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    expect(editor.render(100).join('')).toContain('\x1b_pi:fc')
    expect(app.render()).toContain('50%/128k')
    await exit(app)
  })

  it('斜杠命令补全包含子命令说明，工单参数可按 id 前缀补全', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket('abcdef0123456789', { title: '补全用工单' })] })
    const app = launch(controller)
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    app.terminal.input('/')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
    expect(app.render()).toContain('工单详情')
    editor.setText('')
    app.terminal.input('/ticket abc')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
    expect(app.render()).toContain('补全用工单')
    editor.setText('')
    await exit(app)
  })

  it('斜杠和 @ 本地文件补全调用公开 CombinedAutocompleteProvider', async () => {
    const suggestions = vi.spyOn(CombinedAutocompleteProvider.prototype, 'getSuggestions')
    const app = launch()
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    app.terminal.input('/sta')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
    expect(app.render()).toContain('当前状态')
    expect(suggestions).toHaveBeenCalled()
    editor.setText('')
    app.terminal.input('@package')
    app.terminal.input('\t')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
    expect(app.render()).toContain('package.json')
    editor.setText('')
    await exit(app)
  })

  it('initialPrompt 通过 submit 且脚本事件产生真实回复', async () => {
    const controller = new FakeController()
    controller.script = async (_text, current) => { current.agent({ type: 'message_end', message: assistant('脚本回复') }) }
    const app = launch(controller, new FakeTerminal(), '初始请求')
    await flush()
    expect(controller.submit).toHaveBeenCalledWith('初始请求')
    expect(app.render()).toContain('脚本回复')
    await exit(app)
  })

  it('submit、command、interrupt 错误可显示并继续，close 抛错前终端已恢复', async () => {
    const controller = new FakeController()
    controller.submit.mockRejectedValueOnce(new Error('提交失败'))
    controller.command.mockRejectedValueOnce(new Error('命令失败'))
    const terminal = new FakeTerminal()
    controller.close.mockImplementation(async () => {
      expect(terminal.stopped).toBe(true)
      expect(terminal.cursorVisible).toBe(true)
      throw new Error('关闭失败')
    })
    const app = launch(controller, terminal)
    app.terminal.enter('失败请求')
    await flush()
    app.terminal.enter('/mode coding')
    await flush()
    expect(app.render()).toContain('提交失败')
    expect(app.render()).toContain('命令失败')
    controller.interrupt.mockRejectedValueOnce(new Error('中断失败'))
    controller.emit({ type: 'snapshot', value: snapshot({ running: 1 }) })
    app.terminal.input('\x03')
    await flush()
    expect(app.render()).toContain('中断失败')
    expect(controller.close).not.toHaveBeenCalled()
    const result = expect(app.session).rejects.toThrow('关闭失败')
    app.terminal.enter('/exit')
    await result
    expect(controller.listeners.size).toBe(0)
    expect(terminal.lifecycle.slice(-2)).toEqual(['drain', 'stop'])
  })

  it('本地 user 回显与 agent user message_end 不重复', async () => {
    const app = launch()
    app.terminal.enter('唯一用户消息')
    await flush()
    const message = { role: 'user' as const, content: '唯一用户消息', timestamp: 10 }
    app.controller.agent({ type: 'message_start', message })
    app.controller.agent({ type: 'message_end', message })
    app.controller.agent({ type: 'agent_end', messages: [message] })
    expect(app.render().match(/唯一用户消息/g)).toHaveLength(1)
    await exit(app)
  })

  it('恢复快照中的本地输入不会与本地回显重复出现', async () => {
    const controller = new FakeController()
    const app = launch(controller)
    app.terminal.enter('只显示一次的消息')
    await flush()
    const stored = ticket('T9', { inputs: [{ kind: 'text', id: 'I9', text: '只显示一次的消息', at: 'now' }], assignments: [] })
    controller.emit({ type: 'snapshot', value: snapshot({ tickets: [stored] }) })
    expect(app.render().match(/只显示一次的消息/g)).toHaveLength(1)
    await exit(app)
  })

  it('本地命令参数错误与领域拒绝都用中文说明，且不会显示英文原文', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket()] })
    const app = launch(controller)
    app.terminal.enter('/ticket 不存在的工单')
    await flush()
    expect(app.render()).toContain('未知工单')
    controller.command.mockRejectedValueOnce(new Error('Only an open ticket can be retried'))
    app.terminal.enter('/retry T1')
    await flush()
    expect(app.render()).toContain('Only an open ticket can be retried')
    app.terminal.enter('/debug maybe')
    await flush()
    expect(app.render()).toContain('用法：/debug on|off')
    await exit(app)
  })

  it('短工单 id 先解析成完整 id 再转发给 controller', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket('abcdef0123456789', { title: '短 id 工单' })] })
    const app = launch(controller)
    app.terminal.enter('/stop abcdef01')
    await flush()
    app.terminal.enter('/retry abcdef01')
    await flush()
    app.terminal.enter('/stop nope')
    await flush()
    expect(controller.command.mock.calls.map(call => call[0])).toEqual([
      '/stop abcdef0123456789', '/retry abcdef0123456789',
    ])
    expect(app.render()).toContain('未知工单：nope')
    await exit(app)
  })

  it('连续相同错误只占一行并计数', async () => {
    const controller = new FakeController()
    controller.submit.mockRejectedValue(new Error('模型不可用'))
    const app = launch(controller)
    app.terminal.enter('第一次')
    await flush()
    app.terminal.enter('第二次')
    await flush()
    expect(app.render().match(/模型不可用/g)).toHaveLength(1)
    expect(app.render()).toContain('(2)')
    await exit(app)
  })

  it('/ticket 省略 id 时选择正在运行的工单', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [
      ticket('T-old', { title: '旧工单' }),
      ticket('T-run', { title: '运行中的工单', assignments: [{ id: 'A2', state: 'running', createdAt: 'now' }] }),
    ] })
    const app = launch(controller)
    app.terminal.enter('/ticket')
    await flush()
    const text = app.render()
    expect(text).toContain('T-run')
    expect(text).not.toContain('T-old')
    expect(controller.command).not.toHaveBeenCalled()
    await exit(app)
  })

  it('/new 清空本会话的对话，Esc 在输入非空时只交给编辑器', async () => {
    const controller = new FakeController()
    controller.command.mockImplementation(async () => '已开始新会话')
    const app = launch(controller)
    app.terminal.enter('会被清空的消息')
    await flush()
    expect(app.render()).toContain('会被清空的消息')
    app.terminal.enter('/new')
    await flush()
    expect(app.render()).not.toContain('会被清空的消息')
    expect(app.render()).toContain('已开始新会话')
    app.terminal.input('还没发送')
    app.terminal.input('\x1b')
    await flush()
    expect(app.controller.interrupt).not.toHaveBeenCalled()
    expect(app.terminal.stopped).toBe(false)
    const editor = app.screen?.children.find(child => child instanceof Editor) as Editor
    editor.setText('')
    await exit(app)
  })

  it('footer 对工单标题脱敏且窄终端不溢出', async () => {
    const secret = 'TITLE_SECRET_TOKEN_123456'
    vi.stubEnv('PI_TEST_TOKEN', secret)
    const controller = new FakeController()
    controller.value = snapshot({ tickets: [ticket('T1', { title: `标题 ${secret}` })] })
    const app = launch(controller)
    app.terminal.resize(30)
    expect(app.render()).not.toContain(secret)
    for (const width of [18, 30, 60]) {
      app.terminal.resize(width)
      expect(app.screen?.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    await exit(app)
  })

  it('忙时退出停止工作指示并等待 controller.close', async () => {
    const controller = new FakeController()
    controller.value = snapshot({ running: 1 })
    const close = deferred()
    controller.close.mockImplementation(() => close.promise)
    const removeInput = vi.fn()
    const addInput = TuiMainScreen.prototype.addInputListener
    vi.spyOn(TuiMainScreen.prototype, 'addInputListener').mockImplementation(function (this: TuiMainScreen, listener) {
      const remove = addInput.call(this, listener)
      return () => { removeInput(); remove() }
    })
    const app = launch(controller)
    expect(app.render()).toContain('工作中')
    app.terminal.enter('/exit')
    await flush()
    expect(removeInput).toHaveBeenCalled()
    expect(app.terminal.stopped).toBe(true)
    expect(app.terminal.cursorVisible).toBe(true)
    expect(controller.close).toHaveBeenCalledTimes(1)
    const writes = app.terminal.writes.length
    await flush()
    expect(app.terminal.writes).toHaveLength(writes)
    close.resolve()
    await app.session
  })

  it('启动失败也释放订阅并恢复终端、关闭 controller', async () => {
    const terminal = new FakeTerminal()
    vi.spyOn(terminal, 'start').mockImplementation(() => { throw new Error('启动失败') })
    const controller = new FakeController()
    await expect(runTerminal(controller, { terminal })).rejects.toThrow('启动失败')
    expect(controller.listeners.size).toBe(0)
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(terminal.stopped).toBe(true)
    expect(terminal.cursorVisible).toBe(true)
  })

  it('drainInput 抛错仍停止 TUI 和关闭 controller，移除进程恢复 handler', async () => {
    const terminal = new FakeTerminal()
    terminal.drainError = new Error('drain 失败')
    const before = process.listenerCount('exit')
    const app = launch(new FakeController(), terminal)
    const result = expect(app.session).rejects.toThrow('drain 失败')
    app.terminal.enter('/exit')
    await result
    expect(terminal.stopped).toBe(true)
    expect(app.controller.close).toHaveBeenCalledTimes(1)
    expect(process.listenerCount('exit')).toBe(before)
  })
})
