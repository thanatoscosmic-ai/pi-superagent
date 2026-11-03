import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { startServer, type PiServerHost } from '../src/pi/server.ts'

let directory: string
let store: Store
let server: http.Server
let host: PiServerHost
let base: string
const token = 'test-token'
const ticket: Ticket = { id: 'ticket-1', title: '<img src=x onerror="alert(1)">', decisionId: 'decision', mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [], assignments: [{ id: 'a', state: 'ended', createdAt: '2026-11-03T00:00:00Z', report: { state: 'blocked', summary: 'Needs human', at: '2026-11-03T01:00:00Z' } }], attention: { id: 'question', question: '<script>bad()</script>' }, inputs: [], undelivered: [], createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T01:00:00Z', origin: { triggerId: 'trigger', triggerIds: ['trigger'] } }
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pi-server-'))
  store = new Store(join(directory, 'store.sqlite'))
  store.tickets.save(ticket)
  host = { store, health: vi.fn(() => ({ healthy: true })), receive: vi.fn(), stopTicket: vi.fn(), retryTicket: vi.fn(), pause: vi.fn() }
  server = await startServer(host, { token })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  base = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
const api = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })

it('binds loopback by default and protects every API, including unknown/trigger routes', async () => {
  expect(server.address()).toMatchObject({ address: '127.0.0.1' })
  for (const path of ['/api/health', '/api/tickets', '/api/receive', '/api/pause', '/api/tickets/ticket-1/stop']) {
    const response = await fetch(base + path)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  }
  expect((await api('/api/receive', { actor: { id: 'alice' }, human: true })).status).toBe(404)
  expect(host.receive).not.toHaveBeenCalled()
  expect((await api('/api/health', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401)
  const page = await fetch(base)
  expect(page.status).toBe(200)
  expect(await page.text()).not.toContain(token)
})

it('returns health and ticket attention/waitsForPerson/status without exposing mandates', async () => {
  expect(await (await api('/api/health')).json()).toEqual({ healthy: true })
  const response = await api('/api/tickets')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const tickets = await response.json()
  expect(tickets).toMatchObject([{ id: ticket.id, title: ticket.title, status: 'blocked', waitsForPerson: true, attention: ticket.attention }])
  expect(tickets[0]).not.toHaveProperty('mandate')
  store.tickets.save({ ...ticket, ended: { at: ticket.updatedAt, by: 'human', outcome: 'stopped' } })
  expect(await (await api('/api/tickets')).json()).toMatchObject([{ status: 'stopped', waitsForPerson: false }])
})

it('awaits stop, retry and pause callbacks and strictly validates request bodies', async () => {
  expect((await api('/api/tickets/ticket-1/stop', {})).status).toBe(200)
  expect(host.stopTicket).toHaveBeenCalledWith('ticket-1')
  expect((await api('/api/tickets/ticket-1/retry', {})).status).toBe(200)
  expect(host.retryTicket).toHaveBeenCalledWith('ticket-1')
  expect((await api('/api/pause', { paused: true })).status).toBe(200)
  expect((await api('/api/pause', { paused: false })).status).toBe(200)
  expect(host.pause).toHaveBeenNthCalledWith(1, true)
  expect(host.pause).toHaveBeenNthCalledWith(2, false)
  for (const body of [{ paused: 'true' }, {}, { paused: true, actor: 'alice' }, []]) expect((await api('/api/pause', body)).status).toBe(400)
  expect((await api('/api/tickets/ticket-1/stop', { actor: 'alice' })).status).toBe(400)
  expect((await api('/api/tickets/unknown/stop', {})).status).toBe(404)
  expect((await api('/api/tickets/%ZZ/stop', {})).status).toBe(400)
  expect((await api('/api/tickets/%2F/stop', {})).status).toBe(400)
})

it('rejects CSRF, null origins, cross-site fetches and DNS rebinding without running actions', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    expect((await api('/api/pause', { paused: true }, headers)).status).toBe(403)
  }
  expect(host.pause).not.toHaveBeenCalled()
  expect((await api('/api/pause', { paused: true }, { Origin: base })).status).toBe(200)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(base + '/api/health', { headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
  })
  expect(status).toBe(403)
})

it('enforces content type, JSON syntax, body size, and sanitized async callback failures', async () => {
  expect((await api('/api/pause', { paused: true }, { 'Content-Type': 'text/plain' })).status).toBe(415)
  const malformed = await fetch(base + '/api/pause', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{bad' })
  expect(malformed.status).toBe(400)
  expect((await api('/api/pause', { paused: true, huge: 'x'.repeat(17000) })).status).toBe(413)
  host.stopTicket = vi.fn(async () => { throw new Error('secret credential') })
  const response = await api('/api/tickets/ticket-1/stop', {})
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: '服务内部错误' })
  host.health = async () => { throw new Error('secret') }
  expect((await api('/api/health')).status).toBe(500)
})

it('renders untrusted text through DOM textContent and has CSP with no token persistence', async () => {
  const response = await fetch(base)
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  const html = await response.text()
  expect(html).not.toContain('innerHTML')
  expect(html).not.toContain('localStorage')
  expect(html).not.toContain('sessionStorage')
  const fetchMock = vi.fn(async (path: string) => ({ ok: true, json: async () => path === '/api/health' ? { healthy: true } : [{ ...ticket, status: 'blocked', waitsForPerson: true, report: ticket.assignments[0]!.report }] }))
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: base, beforeParse(window) { window.fetch = fetchMock as unknown as typeof fetch } })
  dom.window.document.getElementById('refresh')!.click()
  await vi.waitFor(() => expect(dom.window.document.querySelector('article h3')?.textContent).toContain(ticket.title))
  expect(dom.window.document.querySelector('article img')).toBeNull()
  expect(dom.window.document.querySelector('article script')).toBeNull()
  expect(dom.window.document.querySelector('article pre')?.textContent).toContain(ticket.attention!.question)
  dom.window.close()
})

it('rejects missing tokens and invalid ports before listening', async () => {
  await expect(startServer(host, { token: '' })).rejects.toThrow('token')
  await expect(startServer(host, { token, port: -1 })).rejects.toThrow('端口')
  await expect(startServer(host, { token, port: 70000 })).rejects.toThrow('端口')
})

it('rejects an unconfigured Feishu webhook before bearer authentication', async () => {
  const response = await fetch(base + '/webhooks/feishu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: '未配置飞书事件接收入口' })
  expect(host.receive).not.toHaveBeenCalled()
})

it('delegates unauthenticated Feishu webhook verification and receive to the source without duplicate intake', async () => {
  const { FeishuSource } = await import('../src/pi/sources.ts')
  let receiveFails = false
  const receive = vi.fn((trigger: import('../src/core/model.ts').Trigger) => { store.triggers.save(trigger); if (receiveFails) throw new Error('接收失败') })
  const transport = vi.fn(async () => ({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_1', create_time: '1793667600000', sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '{"text":"help"}' }, mentions: [] }] } }))
  const source = new FeishuSource({ botId: 'ou_bot', verificationToken: 'verify', store, receive, transport, env: { FEISHU_TENANT_ACCESS_TOKEN: 'tenant' } })
  const webhook = await startServer(host, { token, feishuEvent: body => source.handleEvent(body) })
  const address = webhook.address()
  if (!address || typeof address === 'string') throw new Error('Missing webhook address')
  const url = `http://127.0.0.1:${address.port}/webhooks/feishu`
  const send = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const event = { schema: '2.0', header: { token: 'verify', event_type: 'im.message.receive_v1' }, event: { message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group' } } }
  try {
    const challenge = await send({ type: 'url_verification', token: 'verify', challenge: 'challenge' })
    expect(challenge.status).toBe(200)
    expect(await challenge.json()).toEqual({ challenge: 'challenge' })
    const rejected = await send({ ...event, header: { ...event.header, token: 'wrong' } })
    expect(rejected.status).toBe(500)
    expect(await rejected.json()).toEqual({ error: '服务内部错误' })
    expect(transport).not.toHaveBeenCalled()
    expect((await send(event, { Origin: 'https://evil.example' })).status).toBe(403)
    receiveFails = true
    expect((await send(event)).status).toBe(500)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM pi_source_cursor').get()?.n).toBe(0)
    receiveFails = false
    expect(await (await send(event)).json()).toEqual({ ok: true })
    expect(await (await send(event)).json()).toEqual({ ok: true })
    expect(receive).toHaveBeenCalledTimes(2)
    expect(host.receive).not.toHaveBeenCalled()
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(1)
    expect((await fetch(url)).status).toBe(405)
    expect((await send({}, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await send({ huge: 'x'.repeat(17000) })).status).toBe(413)
  } finally {
    webhook.closeAllConnections()
    await new Promise<void>(resolve => webhook.close(() => resolve()))
  }
})
