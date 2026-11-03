import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { Trigger } from '../core/model.ts'
import type { OutboundMessage } from '../core/ports.ts'
import { CommentSchema, IssueSchema, commentTrigger, issueTrigger, pullTrigger } from '../sources/github-trigger.ts'
import { HistoricalMessageSchema, feishuTrigger, historyEvent } from '../sources/feishu-trigger.ts'

export interface PiSource {
  id: string
  poll?(): Promise<Trigger[]>
  ack?(triggers: Trigger[]): void
  send(message: OutboundMessage): Promise<void>
}

export interface SourceStateOptions { store?: Store; stateDir?: string; receive?: (trigger: Trigger) => unknown }
export interface GitHubRequest { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }
export type GitHubTransport = (request: GitHubRequest) => Promise<unknown>
export interface ClosedThread { thread: { source: string; id: string }; at: string; outcome: 'closed' | 'merged' }
export interface GitHubSourceOptions extends SourceStateOptions {
  repository: string | { owner: string; name: string }
  botUsername: string
  transport?: GitHubTransport
  maxPages?: number
  closed?: (event: ClosedThread) => unknown
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const timestamp = (value: string): string => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error('来源时间戳无效')
  return new Date(time).toISOString()
}

const synchronous = (callback: () => unknown): void => {
  const result = callback()
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
    void Promise.resolve(result).catch(() => {})
    throw new Error('接收与关闭回调必须同步执行，不能返回 Promise')
  }
}

class Cursor {
  private readonly db: DatabaseSync
  private readonly owned: boolean
  constructor(private readonly options: SourceStateOptions, private readonly source: string) {
    if (options.receive && !options.store) throw new Error('配置 receive 时必须提供同一个 Store')
    if (options.receive?.constructor.name === 'AsyncFunction') throw new Error('receive 必须是同步回调')
    if (options.store) { this.db = options.store.db; this.owned = false }
    else {
      if (!options.stateDir) throw new Error('持久化来源游标需要 Store 或 stateDir')
      mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
      const path = join(options.stateDir, 'pi-source.sqlite')
      this.db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      this.owned = true
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS pi_source_cursor (source TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source,key)); CREATE TABLE IF NOT EXISTS pi_source_pending (source TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source,id))')
  }
  pending(): Trigger[] {
    return this.db.prepare('SELECT value FROM pi_source_pending WHERE source=? ORDER BY id').all(this.source).map(row => JSON.parse(String(row.value)) as Trigger)
  }
  private atomic<T>(work: () => T): T {
    if (this.options.store) return this.options.store.atomic(work)
    this.db.exec('SAVEPOINT pi_source_delivery')
    try {
      const result = work()
      this.db.exec('RELEASE pi_source_delivery')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO pi_source_delivery; RELEASE pi_source_delivery')
      throw error
    }
  }
  deliver(triggers: Trigger[], closures: { key: string; event: ClosedThread }[] = [], closed?: (event: ClosedThread) => unknown): Trigger[] {
    return this.atomic(() => {
      const pending = new Map(this.pending().map(trigger => [trigger.id, trigger]))
      for (const trigger of triggers) if (!this.has(trigger.id)) pending.set(trigger.id, trigger)
      const events = [...pending.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      if (this.options.receive) {
        for (const trigger of events) synchronous(() => this.options.receive!(trigger))
        this.save(events.map(trigger => trigger.id))
        this.db.prepare('DELETE FROM pi_source_pending WHERE source=?').run(this.source)
      } else {
        const insert = this.db.prepare('INSERT OR IGNORE INTO pi_source_pending VALUES (?,?,?)')
        for (const trigger of events) insert.run(this.source, trigger.id, JSON.stringify(trigger))
        this.save(events.map(trigger => trigger.id))
      }
      for (const closure of closures) {
        if (this.has(closure.key)) continue
        if (closed) synchronous(() => closed(closure.event))
        this.save([closure.key])
      }
      return events
    })
  }
  ack(triggers: Trigger[]): void {
    this.atomic(() => {
      const remove = this.db.prepare('DELETE FROM pi_source_pending WHERE source=? AND id=?')
      for (const trigger of triggers) remove.run(this.source, trigger.id)
    })
  }
  has(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM pi_source_cursor WHERE source=? AND key=?').get(this.source, key) }
  save(keys: string[]): void {
    this.db.exec('SAVEPOINT pi_source_write')
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO pi_source_cursor VALUES (?,?,?)')
      for (const key of keys) insert.run(this.source, key, new Date().toISOString())
      this.db.exec('RELEASE pi_source_write')
    } catch (error) {
      this.db.exec('ROLLBACK TO pi_source_write; RELEASE pi_source_write')
      throw error
    }
  }
  close(): void { if (this.owned) this.db.close() }
}

export const ghTransport: GitHubTransport = request => new Promise((resolve, reject) => {
  const args = ['api', request.path, '--method', request.method, '-H', 'Accept: application/vnd.github+json']
  if (request.body) args.push('--input', '-')
  const child = execFile('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
    if (error) { reject(new Error('GitHub API 命令失败，请检查 gh 认证与权限')); return }
    try { resolve(JSON.parse(stdout)) } catch { reject(new Error('GitHub API 返回了无效 JSON')) }
  })
  child.stdin?.end(request.body ? JSON.stringify(request.body) : undefined)
})

export class GitHubSource implements PiSource {
  readonly id = 'github'
  private readonly repository: string
  private readonly transport: GitHubTransport
  private readonly cursor: Cursor
  private readonly maxPages: number
  private polling?: Promise<Trigger[]>
  constructor(private readonly options: GitHubSourceOptions) {
    this.repository = typeof options.repository === 'string' ? options.repository : `${options.repository.owner}/${options.repository.name}`
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository) || !options.botUsername.trim()) throw new Error('GitHub 仓库或机器人用户名无效')
    this.maxPages = options.maxPages ?? 1000
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1) throw new Error('分页上限无效')
    if (options.closed?.constructor.name === 'AsyncFunction') throw new Error('closed 必须是同步回调')
    this.transport = options.transport ?? ghTransport
    this.cursor = new Cursor(options, `github:${this.repository.toLowerCase()}`)
  }
  private get(path: string): Promise<unknown> { return this.transport({ method: 'GET', path: `repos/${this.repository}/${path}` }) }
  private async pages(path: string, field?: string): Promise<unknown[]> {
    const result: unknown[] = []
    const fingerprints = new Set<string>()
    for (let page = 1; page <= this.maxPages; page++) {
      const response = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const items = z.array(z.unknown()).parse(field ? z.record(z.string(), z.unknown()).parse(response)[field] : response)
      if (items.length > 100) throw new Error('GitHub 返回的分页大小无效')
      const fingerprint = hash(JSON.stringify(items))
      if (items.length && fingerprints.has(fingerprint)) throw new Error('GitHub 分页未推进，扫描不完整')
      fingerprints.add(fingerprint)
      result.push(...items)
      if (items.length < 100) return result
    }
    throw new Error(`GitHub 已达到分页上限 ${this.maxPages}，扫描不完整`)
  }
  poll(): Promise<Trigger[]> {
    if (this.polling) return this.polling
    this.polling = this.scan().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async scan(): Promise<Trigger[]> {
    if (this.cursor.pending().length) return this.cursor.deliver([])
    const triggers = new Map<string, Trigger>()
    const closures: { key: string; event: ClosedThread }[] = []
    const add = (trigger: Trigger, native: string, user?: { login: string; type?: string } | null) => {
      if (user?.login.toLowerCase() === this.options.botUsername.toLowerCase()) return
      const id = `pi:github:${this.repository.toLowerCase()}:${native}`
      if (this.cursor.has(id)) return
      triggers.set(id, { ...trigger, id, at: timestamp(trigger.at), human: user ? user.type === 'User' && !/\[bot\]$/i.test(user.login) : false,
        channel: trigger.channel ? { ...trigger.channel, address: { ...trigger.channel.address, repository: this.repository } } : undefined,
        meta: { ...trigger.meta, repository: this.repository } })
    }
    const issues = z.array(IssueSchema.extend({ closed_at: z.string().nullish() })).parse(await this.pages('issues?state=all&sort=created&direction=asc'))
    for (const issue of issues) {
      const ref = { number: issue.number, isPr: !!issue.pull_request, url: issue.html_url }
      const originalUser = z.object({ login: z.string(), type: z.string().optional() }).nullable().parse(issue.user)
      const opened = ref.isPr ? pullTrigger(issue, this.options.botUsername) : issueTrigger(issue, this.options.botUsername)
      add(opened, `issue:${issue.number}`, originalUser?.login === 'ghost' ? null : originalUser)
      for (const raw of await this.pages(`issues/${issue.number}/comments`)) {
        const comment = CommentSchema.parse(raw)
        if (!comment.created_at || !comment.updated_at) throw new Error('GitHub 评论缺少可信时间戳')
        add(commentTrigger(comment, ref, 'conversation', this.options.botUsername), `comment:${comment.id}:${timestamp(comment.updated_at)}:${hash(comment.body ?? '')}`, comment.user.login === 'ghost' ? null : comment.user)
      }
      let outcome: 'closed' | 'merged' = 'closed'
      let closedAt = issue.closed_at
      if (ref.isPr) {
        const pull = z.object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }), merged_at: z.string().nullish(), closed_at: z.string().nullish() }).parse(await this.get(`pulls/${issue.number}`))
        outcome = pull.merged_at ? 'merged' : 'closed'
        closedAt = pull.merged_at ?? pull.closed_at ?? closedAt
        for (const kind of ['comments', 'reviews'] as const) {
          for (const raw of await this.pages(`pulls/${issue.number}/${kind}`)) {
            const comment = CommentSchema.parse(raw)
            const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at
            if (!at) throw new Error('GitHub 审查缺少可信时间戳')
            add(commentTrigger(comment, ref, kind === 'reviews' ? 'review' : 'inline', this.options.botUsername), `${kind}:${comment.id}:${timestamp(at)}:${hash(JSON.stringify([comment.body, comment.state]))}`, comment.user.login === 'ghost' ? null : comment.user)
          }
        }
        const checks = await this.pages(`commits/${pull.head.sha}/check-runs`, 'check_runs')
        const statuses = await this.pages(`commits/${pull.head.sha}/statuses`)
        for (const [kind, entries] of [['check', checks], ['status', statuses]] as const) {
          for (const entry of entries) {
            const ci = z.object({ id: z.number(), name: z.string().optional(), context: z.string().optional(), status: z.string().optional(), state: z.string().optional(), conclusion: z.string().nullish(), started_at: z.string().nullish(), completed_at: z.string().nullish(), updated_at: z.string().nullish(), created_at: z.string().nullish(), html_url: z.string().nullish(), target_url: z.string().nullish() }).parse(entry)
            const at = ci.updated_at ?? ci.completed_at ?? ci.started_at ?? ci.created_at
            if (!at) throw new Error('GitHub CI 缺少可信时间戳')
            const state = `${ci.status ?? ci.state ?? ''}:${ci.conclusion ?? ''}`
            add({ ...opened, actor: { source: this.id, id: 'github-ci' }, addressed: undefined, human: false, at, text: `${ci.name ?? ci.context ?? 'CI'}: ${state}`, url: ci.html_url ?? ci.target_url ?? issue.html_url, meta: { number: issue.number, isPr: true, ci: true, sha: pull.head.sha, kind, state } }, `ci:${pull.head.sha}:${kind}:${ci.id}:${state}:${timestamp(at)}`)
          }
        }
      }
      if (issue.state === 'closed') {
        if (!closedAt) throw new Error('GitHub 关闭状态缺少可信时间戳')
        const at = timestamp(closedAt)
        const key = `closed:${issue.number}:${at}:${outcome}`
        if (!this.cursor.has(key)) {
          const event: ClosedThread = { thread: { source: this.id, id: String(issue.number) }, at, outcome }
          closures.push({ key, event })
          add({ ...opened, actor: { source: this.id, id: 'github-state' }, addressed: undefined, human: false, at, text: `${ref.isPr ? 'PR' : 'Issue'} #${issue.number} ${outcome}`, meta: { number: issue.number, isPr: ref.isPr, closed: true, outcome } }, key)
        }
      }
    }
    return this.cursor.deliver([...triggers.values()], closures, this.options.closed)
  }
  ack(triggers: Trigger[]): void { this.cursor.ack(triggers) }
  private sending: Promise<unknown> = Promise.resolve()
  send(message: OutboundMessage): Promise<void> {
    const run = this.sending.then(() => this.post(message))
    this.sending = run.catch(() => {})
    return run
  }
  private async post(message: OutboundMessage): Promise<void> {
    const { number, repository, url } = message.channel.address
    if (message.channel.source !== this.id || !number || !/^[1-9]\d*$/.test(number) || (repository && repository.toLowerCase() !== this.repository.toLowerCase())) throw new Error('GitHub 回复地址无效')
    const inline = url ? /#discussion_r([1-9]\d*)$/.exec(url) : null
    const path = inline ? `pulls/${number}/comments/${inline[1]}/replies` : `issues/${number}/comments`
    const marker = `<!-- pi-superagent:${hash(message.id)} -->`
    const comments = z.array(CommentSchema).parse(await this.pages(inline ? `pulls/${number}/comments` : `issues/${number}/comments`))
    if (comments.some(comment => comment.user.login.toLowerCase() === this.options.botUsername.toLowerCase() && comment.body?.includes(marker))) return
    await this.transport({ method: 'POST', path: `repos/${this.repository}/${path}`, body: { body: `${message.text}\n\n${marker}` } })
  }
  close(): void { this.cursor.close() }
}

export interface FeishuRequest { method: 'GET' | 'POST'; path: string; token?: string; body?: Record<string, unknown> }
export type FeishuTransport = (request: FeishuRequest) => Promise<unknown>
export interface FeishuSourceOptions extends SourceStateOptions {
  botId: string
  appId?: string
  verificationToken: string
  transport?: FeishuTransport
  env?: NodeJS.ProcessEnv
}

export const feishuTransport: FeishuTransport = async request => {
  const response = await fetch(`https://open.feishu.cn/open-apis${request.path}`, {
    method: request.method,
    headers: { 'Content-Type': 'application/json', ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}) },
    body: request.body ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`飞书 API HTTP 错误 ${response.status}`)
  return response.json()
}

export class FeishuSource implements PiSource {
  readonly id = 'feishu'
  private readonly transport: FeishuTransport
  private readonly cursor: Cursor
  private readonly env: NodeJS.ProcessEnv
  private readonly appId: string
  private tenant?: { token: string; expires: number }
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: FeishuSourceOptions) {
    if (!options.botId || !options.verificationToken) throw new Error('必须配置飞书 botId 与 verificationToken')
    this.env = options.env ?? process.env
    this.appId = options.appId ?? this.env.FEISHU_APP_ID ?? ''
    this.transport = options.transport ?? feishuTransport
    this.cursor = new Cursor(options, `feishu:${this.appId || options.botId}`)
  }
  private async token(): Promise<string> {
    if (this.env.FEISHU_TENANT_ACCESS_TOKEN) return this.env.FEISHU_TENANT_ACCESS_TOKEN
    if (this.tenant && this.tenant.expires > Date.now()) return this.tenant.token
    const secret = this.env.FEISHU_APP_SECRET
    if (!this.appId || !secret) throw new Error('缺少飞书认证凭据')
    const response = z.object({ code: z.number(), tenant_access_token: z.string().optional(), expire: z.number().optional() }).parse(await this.transport({ method: 'POST', path: '/auth/v3/tenant_access_token/internal', body: { app_id: this.appId, app_secret: secret } }))
    if (response.code !== 0 || !response.tenant_access_token || !response.expire || response.expire <= 0) throw new Error('飞书认证失败')
    this.tenant = { token: response.tenant_access_token, expires: Date.now() + Math.max(0, response.expire - 60) * 1000 }
    return this.tenant.token
  }
  private async api(request: Omit<FeishuRequest, 'token'>): Promise<unknown> {
    const response = z.object({ code: z.number(), data: z.unknown().optional() }).parse(await this.transport({ ...request, token: await this.token() }))
    if (response.code !== 0) throw new Error(`飞书 API 请求失败，错误码 ${response.code}`)
    return response.data
  }
  handleEvent(input: unknown): Promise<Trigger[] | { challenge: string }> {
    const run = this.queue.then(() => this.event(input))
    this.queue = run.catch(() => {})
    return run
  }
  private async event(input: unknown): Promise<Trigger[] | { challenge: string }> {
    const envelope = z.object({ schema: z.string().optional(), type: z.string().optional(), token: z.string().optional(), challenge: z.string().optional(), header: z.object({ token: z.string(), event_type: z.string() }).optional(), event: z.unknown().optional() }).parse(input)
    if (!equal(envelope.header?.token ?? envelope.token ?? '', this.options.verificationToken)) throw new Error('飞书验证 token 无效')
    if (envelope.type === 'url_verification') {
      if (!envelope.challenge) throw new Error('缺少飞书 challenge')
      return { challenge: envelope.challenge }
    }
    if (envelope.schema !== '2.0' || envelope.header?.event_type !== 'im.message.receive_v1') throw new Error('不支持该飞书事件')
    const event = z.object({ message: z.object({ message_id: z.string().regex(/^om_[A-Za-z0-9_-]+$/), chat_id: z.string().min(1), chat_type: z.enum(['p2p', 'group']) }) }).parse(envelope.event)
    const data = z.object({ items: z.array(HistoricalMessageSchema.extend({ chat_type: z.enum(['p2p', 'group']).optional() })) }).parse(await this.api({ method: 'GET', path: `/im/v1/messages/${encodeURIComponent(event.message.message_id)}` }))
    const message = data.items.find(item => item.message_id === event.message.message_id)
    if (!message || message.chat_id !== event.message.chat_id || !message.sender.id) throw new Error('飞书消息身份或会话不匹配')
    if (message.deleted) return []
    const trigger = feishuTrigger(historyEvent(message, message.chat_id, message.chat_type === 'p2p'), this.options.botId, this.appId)
    if (!trigger) return this.cursor.deliver([])
    return this.cursor.deliver(this.cursor.has(trigger.id) ? [] : [trigger])
  }
  poll(): Promise<Trigger[]> {
    const run = this.queue.then(() => this.cursor.deliver([]))
    this.queue = run.catch(() => {})
    return run
  }
  ack(triggers: Trigger[]): void { this.cursor.ack(triggers) }
  async send(message: OutboundMessage): Promise<void> {
    const { chatId, messageId } = message.channel.address
    if (message.channel.source !== this.id || !chatId) throw new Error('飞书回复地址无效')
    const body = { msg_type: 'text', content: JSON.stringify({ text: message.text }), uuid: hash(message.id).slice(0, 32) }
    if (messageId) {
      if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw new Error('飞书目标消息无效')
      const data = z.object({ items: z.array(HistoricalMessageSchema) }).parse(await this.api({ method: 'GET', path: `/im/v1/messages/${encodeURIComponent(messageId)}` }))
      if (!data.items.some(item => item.message_id === messageId && item.chat_id === chatId && !item.deleted)) throw new Error('飞书回复目标不属于指定会话')
      await this.api({ method: 'POST', path: `/im/v1/messages/${encodeURIComponent(messageId)}/reply`, body: { ...body, reply_in_thread: true } })
    } else await this.api({ method: 'POST', path: '/im/v1/messages?receive_id_type=chat_id', body: { ...body, receive_id: chatId } })
  }
  close(): void { this.cursor.close() }
}
