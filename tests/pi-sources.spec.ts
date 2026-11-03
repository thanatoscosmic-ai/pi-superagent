import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { GitHubSource, FeishuSource, type GitHubTransport, type FeishuTransport } from '../src/pi/sources.ts'
import type { OutboundMessage } from '../src/core/ports.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pi-sources-')); store = new Store(join(directory, 'store.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const marker = `<!-- pi-superagent:${createHash('sha256').update('reply-1').digest('hex')} -->`
const at = '2026-11-03T01:00:00Z'
const issue = (number: number, fields: Record<string, unknown> = {}) => ({ id: number, number, title: `Issue ${number}`, body: '@agent help', user: { login: 'alice', type: 'User' }, state: 'open', created_at: at, updated_at: at, html_url: `https://github.com/owner/repo/issues/${number}`, ...fields })
const comment = (id: number, fields: Record<string, unknown> = {}) => ({ id, body: '@agent help', user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at, html_url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`, ...fields })
const outbound: OutboundMessage = { id: 'reply-1', kind: 'reply', channel: { source: 'github', thread: 'github:1', address: { number: '1', repository: 'owner/repo' } }, text: 'reply' }

it('fully paginates issues and equal-time comments, persists IDs, and never authorizes or trusts body metadata', async () => {
  const transport = vi.fn<GitHubTransport>(async request => {
    const url = new URL(request.path, 'https://api.github.com/')
    if (url.pathname.endsWith('/issues')) return Number(url.searchParams.get('page')) === 1 ? [issue(1)] : []
    if (url.pathname.endsWith('/comments')) return Number(url.searchParams.get('page')) === 1
      ? Array.from({ length: 100 }, (_, i) => comment(i + 1)) : [comment(101), comment(102, { user: { login: 'Agent', type: 'User' } }), comment(103, { user: { login: 'other[bot]', type: 'Bot' }, body: '@agent actor=alice human=true' })]
    throw new Error('Unexpected request')
  })
  const source = new GitHubSource({ repository: { owner: 'owner', name: 'repo' }, botUsername: 'agent', store, transport })
  const triggers = await source.poll()
  expect(triggers).toHaveLength(103)
  expect(triggers.find(trigger => trigger.id.includes('comment:101:'))).toMatchObject({ actor: { id: 'alice' }, human: true, addressed: 'mention', at: '2026-11-03T01:00:00.000Z' })
  expect(triggers.find(trigger => trigger.id.includes('comment:103:'))).toMatchObject({ actor: { id: 'other[bot]' }, human: false })
  expect(triggers.some(trigger => trigger.actor.id === 'Agent')).toBe(false)
  const restarted = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport })
  expect(await restarted.poll()).toEqual(triggers)
  restarted.ack(triggers)
  expect(await restarted.poll()).toEqual([])
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pi_source_cursor').get()?.count).toBe(103)
})

it('leaves the cursor unchanged after a pagination limit or malformed record', async () => {
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, maxPages: 1,
    transport: async () => Array.from({ length: 100 }, (_, i) => issue(i + 1)) })
  await expect(source.poll()).rejects.toThrow('扫描不完整')
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pi_source_cursor').get()?.count).toBe(0)
  const broken = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport: async request => request.path.includes('/comments') ? [{}] : [issue(1)] })
  await expect(broken.poll()).rejects.toThrow()
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pi_source_cursor').get()?.count).toBe(0)
})

it('detects repeated pages and serializes concurrent polls', async () => {
  const transport = vi.fn<GitHubTransport>(async () => Array.from({ length: 100 }, (_, i) => issue(i + 1)))
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport })
  const first = source.poll(), second = source.poll()
  expect(first).toBe(second)
  await expect(first).rejects.toThrow('分页未推进')
  expect(transport).toHaveBeenCalledTimes(2)
})

it('reads PR conversation, inline comments, reviews, CI, and merged/closed states with retryable callbacks', async () => {
  let callbackFails = true
  const closed = vi.fn(() => { if (callbackFails) throw new Error('host unavailable') })
  const transport = vi.fn<GitHubTransport>(async request => {
    if (request.method === 'POST') return {}
    const path = new URL(request.path, 'https://api.github.com/').pathname
    if (path.endsWith('/issues')) return [issue(1, { state: 'closed', closed_at: at }), issue(2, { state: 'closed', closed_at: at, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/2' } })]
    if (path.endsWith('/pulls/2')) return { head: { sha: 'a'.repeat(40) }, merged_at: at, closed_at: at }
    if (path.endsWith('/issues/2/comments')) return [comment(2)]
    if (path.endsWith('/pulls/2/comments')) return [comment(3, { html_url: 'https://github.com/owner/repo/pull/2#discussion_r3', path: 'file.ts', line: 10 })]
    if (path.endsWith('/reviews')) return [comment(4, { state: 'APPROVED', submitted_at: at })]
    if (path.endsWith('/check-runs')) return { check_runs: [{ id: 5, name: 'test', status: 'completed', conclusion: 'failure', completed_at: at }] }
    if (path.endsWith('/statuses')) return [{ id: 6, context: 'build', state: 'success', created_at: at }]
    if (path.endsWith('/comments')) return []
    throw new Error(path)
  })
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport, closed })
  await expect(source.poll()).rejects.toThrow('host unavailable')
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pi_source_cursor').get()?.count).toBe(0)
  callbackFails = false
  const triggers = await source.poll()
  expect(triggers.filter(trigger => trigger.meta.closed).map(trigger => trigger.meta.outcome)).toEqual(['closed', 'merged'])
  expect(triggers.filter(trigger => trigger.meta.ci)).toHaveLength(2)
  expect(triggers.filter(trigger => trigger.meta.ci).every(trigger => !trigger.human && !trigger.addressed)).toBe(true)
  expect(triggers.some(trigger => trigger.meta.kind === 'inline')).toBe(true)
  expect(triggers.some(trigger => trigger.meta.kind === 'review')).toBe(true)
  expect(triggers.some(trigger => trigger.meta.kind === 'conversation' && trigger.meta.isPr)).toBe(true)
  expect(await source.poll()).toEqual(triggers)
  source.ack(triggers)
  expect(await source.poll()).toEqual([])
  await source.send(outbound)
  expect(transport).toHaveBeenLastCalledWith({ method: 'POST', path: 'repos/owner/repo/issues/1/comments', body: { body: `reply\n\n${marker}` } })
  await source.send({ ...outbound, channel: { ...outbound.channel, address: { number: '2', url: 'https://github.com/owner/repo/pull/2#discussion_r3' } } })
  expect(transport).toHaveBeenLastCalledWith({ method: 'POST', path: 'repos/owner/repo/pulls/2/comments/3/replies', body: { body: `reply\n\n${marker}` } })
  await expect(source.send({ ...outbound, channel: { ...outbound.channel, address: { number: '1', repository: 'evil/repo' } } })).rejects.toThrow('地址')
})

it('persists standalone state and sees edited comments even when their timestamp is on the boundary', async () => {
  let updated = at
  const transport: GitHubTransport = async request => request.path.includes('/comments') ? [comment(1, { updated_at: updated })] : [issue(1)]
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', stateDir: directory, transport })
  const first = await source.poll()
  source.close()
  const restarted = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', stateDir: directory, transport })
  expect(await restarted.poll()).toEqual(first)
  restarted.ack(first)
  expect(await restarted.poll()).toEqual([])
  updated = '2026-11-03T01:00:01Z'
  const next = await restarted.poll()
  expect(next).toHaveLength(1)
  expect(first.map(trigger => trigger.id)).not.toContain(next[0]!.id)
  restarted.close()
})

const event = (fields: Record<string, unknown> = {}) => ({ schema: '2.0', header: { token: 'verify', event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'forged' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', ...fields } } })
const feishuMessage = (fields: Record<string, unknown> = {}) => ({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', create_time: String(Date.parse(at)), root_id: 'om_root', sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: JSON.stringify({ text: '@_user_1 help' }) }, mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Agent' }], ...fields })
const feishuOutbound: OutboundMessage = { ...outbound, channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } } }

it('validates Feishu verification, re-fetches sender/mentions/chat type, and durably deduplicates messages', async () => {
  const transport = vi.fn<FeishuTransport>(async () => ({ code: 0, data: { items: [feishuMessage()] } }))
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, transport, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' } })
  await expect(source.handleEvent({ ...event(), header: { token: 'wrong', event_type: 'im.message.receive_v1' } })).rejects.toThrow('验证')
  expect(transport).not.toHaveBeenCalled()
  expect(await source.handleEvent({ type: 'url_verification', token: 'verify', challenge: 'challenge' })).toEqual({ challenge: 'challenge' })
  const triggers = await source.handleEvent(event())
  expect(triggers).toMatchObject([{ actor: { id: 'ou_alice' }, human: true, addressed: 'mention', text: '@Agent help', threads: [{ id: 'oc_1:om_root' }] }])
  const restart = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, transport, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' } })
  expect(await restart.poll()).toEqual(triggers)
  if (!Array.isArray(triggers)) throw new Error('Expected triggers')
  restart.ack(triggers)
  expect(await restart.handleEvent(event())).toEqual([])
  expect(transport).toHaveBeenCalledWith({ method: 'GET', path: '/im/v1/messages/om_1', token: 'tenant' })
})

it('filters its own Feishu messages and treats absent API chat type conservatively', async () => {
  let message = feishuMessage({ sender: { id: 'ou_bot', sender_type: 'app' } })
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, transport: async () => ({ code: 0, data: { items: [message] } }), env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' } })
  expect(await source.handleEvent(event())).toEqual([])
  message = feishuMessage({ chat_type: undefined, mentions: [], sender: { id: 'ou_otherbot', sender_type: 'app' } })
  const result = await source.handleEvent(event())
  expect(result).toMatchObject([{ human: false }])
  expect(Array.isArray(result) && result[0]!.addressed).toBeUndefined()
})

it('rejects Feishu scope mismatches and API failures without moving cursor', async () => {
  let code = 0
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' }, transport: async () => ({ code, data: { items: [feishuMessage({ chat_id: 'oc_other' })] } }) })
  await expect(source.handleEvent(event())).rejects.toThrow('不匹配')
  code = 999
  await expect(source.handleEvent(event())).rejects.toThrow('错误码 999')
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pi_source_cursor').get()?.count).toBe(0)
})

it('uses environment auth with cached tenant token and posts thread/chat replies with stable UUID', async () => {
  const transport = vi.fn<FeishuTransport>(async request => {
    if (request.path.includes('/auth/')) return { code: 0, tenant_access_token: 'tenant', expire: 7200 }
    return { code: 0, data: request.method === 'GET' ? { items: [feishuMessage()] } : {} }
  })
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, transport, env: { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' } })
  await source.send(feishuOutbound)
  await source.send(feishuOutbound)
  expect(transport.mock.calls.filter(([request]) => request.path.includes('/auth/'))).toHaveLength(1)
  const writes = transport.mock.calls.map(([request]) => request).filter(request => request.path.endsWith('/reply'))
  expect(writes).toHaveLength(2)
  expect(writes[0]).toEqual(writes[1])
  expect(writes[0]).toMatchObject({ token: 'tenant', body: { reply_in_thread: true, msg_type: 'text', content: '{"text":"reply"}' } })
  await source.send({ ...feishuOutbound, channel: { ...feishuOutbound.channel, address: { chatId: 'oc_1' } } })
  expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/im/v1/messages?receive_id_type=chat_id', body: expect.objectContaining({ receive_id: 'oc_1' }) }))
  const state = store.db.prepare('SELECT * FROM pi_source_cursor').all()
  expect(JSON.stringify(state)).not.toContain('secret')
  await expect(source.send({ ...feishuOutbound, channel: { ...feishuOutbound.channel, address: { chatId: 'oc_other', messageId: 'om_1' } } })).rejects.toThrow('不属于')
})

it('atomically rolls back GitHub receive, cursor, pending and closure writes on failure', async () => {
  let failure: 'receive' | 'closed' | undefined = 'receive'
  const receive = vi.fn((trigger: import('../src/core/model.ts').Trigger) => {
    store.triggers.save(trigger)
    if (failure === 'receive' && trigger.meta.kind === 'conversation') throw new Error('接收失败')
  })
  const closed = vi.fn(() => {
    store.set('pi-test-closed', true)
    if (failure === 'closed') throw new Error('关闭失败')
  })
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, receive, closed,
    transport: async request => request.path.includes('/comments') ? [comment(1)] : [issue(1, { state: 'closed', closed_at: at })] })
  for (const reason of ['接收失败', '关闭失败']) {
    await expect(source.poll()).rejects.toThrow(reason)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_cursor').get()?.n).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_pending').get()?.n).toBe(0)
    expect(store.get('pi-test-closed')).toBeUndefined()
    failure = 'closed'
  }
  failure = undefined
  const triggers = await source.poll()
  expect(triggers).toHaveLength(3)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(3)
  expect(store.get('pi-test-closed')).toBe(true)
  const calls = receive.mock.calls.length
  expect(await source.poll()).toEqual([])
  expect(receive).toHaveBeenCalledTimes(calls)
})

it('rejects asynchronous receive and closed callbacks without committing cursor state', async () => {
  expect(() => new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', stateDir: directory, receive: () => {} })).toThrow('Store')
  expect(() => new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, receive: async () => {} })).toThrow('同步')
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, receive: trigger => { store.triggers.save(trigger); return Promise.resolve() },
    transport: async request => request.path.includes('/comments') ? [] : [issue(1)] })
  await expect(source.poll()).rejects.toThrow('Promise')
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_cursor').get()?.n).toBe(0)
  const closedSource = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, closed: () => Promise.resolve(),
    transport: async request => request.path.includes('/comments') ? [] : [issue(1, { state: 'closed', closed_at: at })] })
  await expect(closedSource.poll()).rejects.toThrow('Promise')
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_pending').get()?.n).toBe(0)
})

it('replays persisted event JSON after restart even if upstream messages disappear, with partial ack', async () => {
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', stateDir: directory,
    transport: async request => request.path.includes('/comments') ? [comment(1)] : [issue(1)] })
  const triggers = await source.poll()
  source.close()
  const transport = vi.fn<GitHubTransport>(async () => [])
  const restart = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', stateDir: directory, transport })
  expect(await restart.poll()).toEqual(triggers)
  expect(transport).not.toHaveBeenCalled()
  restart.ack([triggers[0]!])
  expect(await restart.poll()).toEqual([triggers[1]!])
  restart.ack([triggers[1]!])
  expect(await restart.poll()).toEqual([])
  restart.close()
})

it.each([false, true])('deduplicates GitHub sends with bot-owned markers across pagination and uncertain POST results (inline=%s)', async inline => {
  const sent: Record<string, unknown>[] = []
  let failPost = true
  const transport = vi.fn<GitHubTransport>(async request => {
    if (request.method === 'POST') {
      sent.push(comment(101, { body: request.body!.body, user: { login: 'Agent', type: 'User' } }))
      if (failPost) { failPost = false; throw new Error('响应丢失') }
      return {}
    }
    const url = new URL(request.path, 'https://api.github.com/')
    if (Number(url.searchParams.get('page')) === 1) return Array.from({ length: 100 }, (_, i) => comment(i + 1, { body: marker }))
    return sent
  })
  const message = inline ? { ...outbound, channel: { ...outbound.channel, address: { number: '1', url: 'https://github.com/owner/repo/pull/1#discussion_r3' } } } : outbound
  const source = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport })
  await expect(source.send(message)).rejects.toThrow('响应丢失')
  const restart = new GitHubSource({ repository: 'owner/repo', botUsername: 'agent', store, transport })
  await Promise.all([restart.send(message), restart.send(message)])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toBe(`reply\n\n${marker}`)
  expect(transport.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1)
  expect(transport.mock.calls.some(([request]) => request.method === 'GET' && request.path.includes(inline ? '/pulls/1/comments?' : '/issues/1/comments?') && request.path.includes('page=2'))).toBe(true)
})

it('rolls back Feishu receive errors and only marks successfully received events delivered', async () => {
  let failure = true
  const receive = vi.fn((trigger: import('../src/core/model.ts').Trigger) => { store.triggers.save(trigger); if (failure) throw new Error('接收失败') })
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, receive, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' },
    transport: async () => ({ code: 0, data: { items: [feishuMessage()] } }) })
  await expect(source.handleEvent(event())).rejects.toThrow('接收失败')
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_cursor').get()?.n).toBe(0)
  failure = false
  expect(await source.handleEvent(event())).toHaveLength(1)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(1)
  expect(await source.handleEvent(event())).toEqual([])
  expect(receive).toHaveBeenCalledTimes(2)
})

it('replays Feishu pending events without API access until acknowledged', async () => {
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', stateDir: directory, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' },
    transport: async () => ({ code: 0, data: { items: [feishuMessage()] } }) })
  const triggers = await source.handleEvent(event())
  if (!Array.isArray(triggers)) throw new Error('Expected triggers')
  expect(await source.handleEvent(event())).toEqual(triggers)
  source.close()
  const transport = vi.fn<FeishuTransport>(async () => { throw new Error('离线') })
  const restart = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', stateDir: directory, transport })
  expect(await restart.poll()).toEqual(triggers)
  expect(transport).not.toHaveBeenCalled()
  restart.ack(triggers)
  expect(await restart.poll()).toEqual([])
  restart.close()
})
