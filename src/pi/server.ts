import * as http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { latestAssignment, waitsForPerson, type Trigger } from '../core/model.ts'

export interface PiServerHost {
  store: Store
  health: () => unknown
  receive: (trigger: Trigger) => unknown
  stopTicket: (id: string) => unknown
  retryTicket: (id: string) => unknown
  deleteTicket: (id: string) => unknown
  pause: (paused: boolean) => unknown
}
export interface PiServerOptions {
  port?: number
  token: string
  host?: string
  feishuEvent?: (body: unknown) => Promise<Trigger[] | { challenge: string }>
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const authorized = (header: string | undefined, token: string): boolean => {
  if (!header?.startsWith('Bearer ')) return false
  const left = Buffer.from(header.slice(7)), right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new RequestError(415, '请求必须使用 application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 16_384) throw new RequestError(413, '请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RequestError(400, 'JSON 格式无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, '请求体必须是 JSON 对象')
  return value as Record<string, unknown>
}

const page = (nonce: string): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Superagent</title></head>
<body><h1>Pi Superagent</h1><label>Bearer token <input id="token" type="password" autocomplete="off"></label><button id="refresh">刷新</button><button id="pause">暂停</button><button id="resume">恢复</button><p id="error" role="alert"></p><h2>Health</h2><pre id="health"></pre><h2>Tickets</h2><section id="tickets"></section>
<script nonce="${nonce}">
const element = id => document.getElementById(id);
async function api(path, data) {
  const response = await fetch(path, {method: data === undefined ? 'GET' : 'POST', headers: {Authorization: 'Bearer ' + element('token').value, ...(data === undefined ? {} : {'Content-Type': 'application/json'})}, ...(data === undefined ? {} : {body: JSON.stringify(data)}), credentials: 'omit'});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
async function refresh() {
  try {
    element('error').textContent = '';
    const [health, tickets] = await Promise.all([api('/api/health'), api('/api/tickets')]);
    element('health').textContent = JSON.stringify(health, null, 2);
    element('tickets').replaceChildren();
    for (const ticket of tickets) {
      const row = document.createElement('article');
      const title = document.createElement('h3');
      title.textContent = ticket.title + ' [' + ticket.status + ']';
      const detail = document.createElement('pre');
      detail.textContent = JSON.stringify({id: ticket.id, attention: ticket.attention, waitsForPerson: ticket.waitsForPerson, report: ticket.report}, null, 2);
      row.append(title, detail);
      for (const action of ['stop', 'retry', 'delete']) {
        const button = document.createElement('button');
        button.textContent = action;
        button.addEventListener('click', async () => {try {await api('/api/tickets/' + encodeURIComponent(ticket.id) + '/' + action, {}); await refresh();} catch (error) {element('error').textContent = error.message;}});
        row.append(button);
      }
      element('tickets').append(row);
    }
  } catch (error) {element('error').textContent = error.message;}
}
element('refresh').addEventListener('click', refresh);
for (const [id, paused] of [['pause', true], ['resume', false]]) element(id).addEventListener('click', async () => {try {await api('/api/pause', {paused}); await refresh();} catch (error) {element('error').textContent = error.message;}});
</script></body></html>`

export async function startServer(host: PiServerHost, options: PiServerOptions): Promise<http.Server> {
  if (!options.token || /[\r\n]/.test(options.token)) throw new Error('必须提供非空 Bearer token')
  const bind = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('服务端口无效')
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    const json = (status: number, value: unknown) => {
      const encoded = JSON.stringify(value ?? null)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(encoded)
    }
    void (async () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new RequestError(503, '服务暂不可用')
      const hosts = new Set([`${bind.includes(':') ? `[${bind}]` : bind}:${address.port}`])
      if (bind === '127.0.0.1' || bind === '::1') hosts.add(`localhost:${address.port}`)
      if (!request.headers.host || !hosts.has(request.headers.host.toLowerCase())) throw new RequestError(403, '请求 Host 无效')
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new RequestError(400, '请求地址无效')
      const url = new URL(request.url, `http://${request.headers.host}`)
      if (request.method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(18).toString('base64')
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(page(nonce))
        return
      }
      if (url.pathname === '/webhooks/feishu') {
        if (!options.feishuEvent) throw new RequestError(404, '未配置飞书事件接收入口')
        if (request.method !== 'POST') throw new RequestError(405, '飞书事件入口仅支持 POST')
        if (request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '拒绝浏览器跨站事件请求')
        const result = await options.feishuEvent(await body(request))
        json(200, Array.isArray(result) ? { ok: true } : result)
        return
      }
      if (!authorized(request.headers.authorization, options.token)) {
        response.setHeader('WWW-Authenticate', 'Bearer')
        throw new RequestError(401, '未授权，请提供有效的 Bearer token')
      }
      const origin = request.headers.origin
      if ((origin && origin !== `http://${request.headers.host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '拒绝跨站请求')
      if (request.method === 'GET' && url.pathname === '/api/health') { json(200, await host.health()); return }
      if (request.method === 'GET' && url.pathname === '/api/tickets') {
        json(200, host.store.tickets.list().map(ticket => {
          const assignment = latestAssignment(ticket)
          return { id: ticket.id, title: ticket.title, status: ticket.ended?.outcome ?? (assignment?.state === 'running' || assignment?.state === 'pending' ? assignment.state : assignment?.report?.state ?? 'open'),
            attention: ticket.attention ?? null, waitsForPerson: !ticket.ended && waitsForPerson(ticket), report: assignment?.report ?? null,
            ended: ticket.ended ?? null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt }
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/pause') {
        const value = await body(request)
        if (typeof value.paused !== 'boolean' || Object.keys(value).some(key => key !== 'paused')) throw new RequestError(400, 'paused 必须是布尔值且不能包含其他字段')
        await host.pause(value.paused)
        json(200, { ok: true })
        return
      }
      const match = /^\/api\/tickets\/([^/]+)\/(stop|retry|delete)$/.exec(url.pathname)
      if (request.method === 'POST' && match) {
        let id: string
        try { id = decodeURIComponent(match[1]!) } catch { throw new RequestError(400, '任务 ID 无效') }
        if (!id || id.length > 512 || /[\x00-\x1f/\\]/.test(id)) throw new RequestError(400, '任务 ID 无效')
        if (!host.store.tickets.get(id)) throw new RequestError(404, '任务不存在')
        const value = await body(request)
        if (Object.keys(value).length) throw new RequestError(400, '请求体必须是空 JSON 对象')
        await (match[2] === 'stop' ? host.stopTicket(id) : match[2] === 'delete' ? host.deleteTicket(id) : host.retryTicket(id))
        json(200, { ok: true })
        return
      }
      throw new RequestError(404, '接口不存在')
    })().catch(error => {
      if (response.headersSent || response.destroyed) { response.end(); return }
      json(error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : '服务内部错误' })
    })
  })
  server.keepAliveTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => { server.off('error', reject); resolve() })
  })
  return server
}
