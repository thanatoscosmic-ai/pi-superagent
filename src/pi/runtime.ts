import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lockSync } from 'proper-lockfile'
import { Engine, key, latestAssignment, type OutboundMessage, type SourceScope, type Trigger } from '../core/index.ts'
import { Store } from '../app/store.ts'
import { Effects, Later } from '../app/effects.ts'
import { HealthBoard } from '../infra/health.ts'
import { assessmentOutcome, policyEffects, policyVersion, settingsPolicy, SettingsSchema, type Settings } from '../policy.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { createPiAgent } from './model.ts'
import { PiExecutor } from './executor.ts'
import { assessCandidate } from './assessment.ts'
import type { RuntimeConfig } from './types.ts'

export interface RuntimeSource {
  id: string
  poll?(): Promise<Trigger[]>
  ack?(triggers: Trigger[]): void
  send(message: OutboundMessage): Promise<void>
}

export class PiRuntime {
  readonly store: Store
  readonly effects: Effects
  readonly engine: Engine
  readonly executor: PiExecutor
  readonly board = new HealthBoard()
  private readonly sources = new Map<string, RuntimeSource>()
  private readonly release: () => void
  private timer?: ReturnType<typeof setInterval>
  private closing = false
  private readonly lifetime = new AbortController()
  private polling?: Promise<void>
  private readonly runtimeHealth = this.board.claim('runtime')
  private readonly sourceHealth = this.board.claim('sources')
  private readonly factory: import('./types.ts').AgentFactory
  /** The SourceScope the Policy judges admissibility with; the terminal asks the same gate before spending a model call. */
  readonly sourceScope: SourceScope

  constructor(readonly config: RuntimeConfig) {
    config.stateDir = resolve(config.stateDir)
    config.repositoryDirectory = resolve(config.repositoryDirectory)
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    this.release = lockSync(config.stateDir, { stale: 30_000 })
    try { this.store = new Store(join(config.stateDir, 'orchestrator.sqlite')) }
    catch (error) { this.release(); throw error }
    this.factory = config.agentFactory ?? createPiAgent
    this.effects = new Effects(this.store, this.board)
    this.sourceScope = { scope: (input: Parameters<SourceScope['scope']>[0]) => {
      if (this.store.settings().sources[input.source]?.enabled === false) return { listened: false, reason: 'source_disabled' }
      return input.source === 'local' || this.sources.has(input.source)
        ? { listened: true, observed: true, row: 'default' } : { listened: false, reason: 'source_disabled' }
    } }
    this.executor = new PiExecutor({ store: this.store, effects: this.effects, engine: () => this.engine,
      config, agentFactory: this.factory, paused: () => this.closing || this.store.settings().paused })
    this.engine = new Engine({
      repo: this.store, scope: this.sourceScope, policy: () => settingsPolicy(this.store.settings(), this.sourceScope),
      assessor: {
        request: candidate => this.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }),
        release: id => this.effects.cancel('assessment', id),
      },
      executor: this.executor,
      prepareTicket: (ticket, outcome) => this.executor.prepare(ticket, outcome),
      outbox: {
        send: message => this.store.atomic(() => { if (this.store.receipts.add(message)) this.effects.enqueue('reply', message.id, {}) }),
        status: id => this.store.replyStatus(id),
        withdraw: id => { this.store.receipts.withdraw(id); this.effects.cancel('reply', id) },
      },
      emit: event => {
        this.store.afterCommit(() => config.onDomainEvent?.(event))
        if (event.type === 'ticket.ended') {
          const ended = this.store.tickets.get(event.data.ticketId)
          if (ended && ['merged', 'closed'].includes(event.data.outcome)) {
            for (const channel of ended.channels) if (!this.store.threads.get(`${channel.source}:${channel.thread}`)?.context?.includes(ended.id)) {
              const text = `工单 ${ended.title} 的 PR 已${event.data.outcome === 'merged' ? '合并' : '关闭（未合并）'}。`
              const message = { id: key('pull-end', ended.id, channel.thread, event.data.outcome), channel, text, kind: 'notice' as const, ticketId: ended.id }
              if (this.store.receipts.add(message)) this.effects.enqueue('reply', message.id, {})
            }
          }
          this.store.afterCommit(() => {
            const ticket = this.store.tickets.get(event.data.ticketId)
            if (ticket) config.onResult?.(ticket)
          })
        }
      },
    })
    this.effects.handle('assessment', async ({ triggerId }, evalId) => {
      if (this.store.settings().paused) throw new Later()
      const candidate = this.engine.candidate(triggerId)
      if (!candidate || candidate.evalId !== evalId) return
      this.engine.candidateDelivered(evalId)
      try {
        const assessment = config.assess ? await config.assess(candidate) : await assessCandidate(this.factory, candidate, this.store.settings(), this.lifetime.signal)
        if (!this.closing && this.engine.candidate(triggerId)?.evalId === evalId) this.engine.decide(triggerId, {
          ...assessmentOutcome(assessment, this.store.settings(), candidate.strength), evalId,
        })
      } catch {
        if (!this.closing && this.engine.candidate(triggerId)?.evalId === evalId) this.engine.decide(triggerId, {
          kind: 'unavailable', reason: '评估失败；检查模型接口、凭据及结构化输出', evalId,
        })
      }
    }, { limit: () => this.store.settings().paused ? 0 : 1 })
    this.effects.handle('reply', async (_payload, id) => {
      if (this.store.settings().paused) throw new Later()
      const message = this.store.receipts.get(id)
      if (!message || message.status !== 'pending') return
      if (this.store.receipts.behind(id, 3)) throw new Later()
      const source = this.sources.get(message.channel.source)
      if (!source || this.store.settings().sources[source.id]?.enabled === false) throw new Later()
      await source.send(message)
      this.store.receipts.settle(message, 'sent')
    })
  }

  register(source: RuntimeSource): void {
    if (this.sources.has(source.id)) throw new Error(`重复 Source：${source.id}`)
    this.sources.set(source.id, source)
  }

  configure(settings: unknown): Settings {
    const old = this.store.settings()
    const scope = (settings: Settings): SourceScope => ({ scope: input => settings.sources[input.source]?.enabled === false
      ? { listened: false, reason: 'source_disabled' }
      : input.source === 'local' || this.sources.has(input.source)
        ? { listened: true, observed: true, row: 'default' } : { listened: false, reason: 'source_disabled' } })
    return this.store.atomic(() => {
      const next = SettingsSchema.parse(settings)
      if (next.executor.prepare.trim()) throw new Error('pi 宿主不支持非空 executor.prepare，请清空该配置')
      if (next.executor.directory && resolve(next.executor.directory) !== resolve(this.config.stateDir, 'work')) {
        throw new Error('pi 宿主执行目录必须是状态目录下的 work')
      }
      this.store.saveSettings(next)
      if (policyVersion(old) !== policyVersion(next)) this.engine.policyChanged(policyVersion(old), policyVersion(next),
        policyEffects(this.store.tickets.open(), old, next, scope))
      return next
    })
  }

  async pause(paused: boolean): Promise<void> {
    this.configure({ ...this.store.settings(), paused })
    if (paused) this.executor.pause()
    else { await this.executor.resumePaused(); this.engine.evaluateDue(); this.effects.kick() }
  }

  receive(trigger: Trigger) { return this.engine.receive(trigger) }

  submit(text: string, actor = 'operator', thread: string = randomUUID()): string {
    const id = key('local', thread, randomUUID())
    this.receive({ id, source: 'local', threads: [{ source: 'local', id: thread }], actor: { source: 'local', id: actor },
      human: true, addressed: 'direct', at: new Date().toISOString(), text,
      channel: { source: 'local', thread, address: {} }, meta: {} })
    return id
  }

  start(): void {
    if (this.timer) return
    const settings = this.store.settings()
    if (settings.executor.prepare.trim() || settings.executor.directory && resolve(settings.executor.directory) !== resolve(this.config.stateDir, 'work')) {
      throw new Error('pi 宿主配置不兼容，请清空 executor.prepare 并恢复默认执行目录')
    }
    this.executor.resume()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'pi-superagent 正在运行' })
    this.timer = setInterval(() => { void this.pump().catch(() => {
      this.runtimeHealth.set({ state: 'error', detail: '运行轮次失败；检查配置和状态目录' })
    }) }, 2000)
  }

  async poll(): Promise<void> {
    for (const source of this.sources.values()) {
      if (!source.poll || this.store.settings().sources[source.id]?.enabled === false) continue
      try {
        const triggers = await source.poll()
        this.store.atomic(() => {
          for (const trigger of triggers) if (!this.store.triggers.get(trigger.id)) this.receive(trigger)
          source.ack?.(triggers)
        })
        this.sourceHealth.set({ state: 'ready', detail: 'Source 已同步' })
      } catch { this.sourceHealth.set({ state: 'error', detail: `${source.id} 同步失败；检查认证与网络` }) }
    }
  }

  async pump(): Promise<void> {
    if (this.closing) return
    this.polling ??= this.poll().finally(() => { this.polling = undefined })
    await this.polling
    this.engine.evaluateDue()
    this.effects.kick()
  }

  async idle(timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.engine.evaluateDue()
      await this.effects.idle()
      await this.executor.idle()
      await this.effects.idle()
      const row = this.store.db.prepare('SELECT MIN(due) AS due FROM effect').get()
      const due = row?.due === null || row?.due === undefined ? undefined : Number(row.due)
      if (!this.store.threads.active().length && due === undefined) return
      if (this.store.settings().paused) throw new Error('工作已暂停，恢复后使用 serve 继续执行')
      if (Date.now() >= deadline) throw new Error('等待工作完成超时；持久化任务将由 serve 继续执行')
      await delay(Math.min(Math.max(20, (due ?? Date.now() + 100) - Date.now()), deadline - Date.now()), undefined,
        { signal: this.lifetime.signal })
    }
  }

  health() { return this.board.all }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.lifetime.abort()
    clearInterval(this.timer)
    try {
      await this.polling
      await this.executor.shutdown()
      await this.effects.drain()
    } finally { try { this.store.close() } finally { this.release() } }
  }

  status() {
    return this.store.tickets.list().map(ticket => ({ id: ticket.id, title: ticket.title,
      outcome: ticket.ended?.outcome, report: latestAssignment(ticket)?.report, attention: ticket.attention }))
  }
}
