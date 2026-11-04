#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { runCoding } from './coding.ts'
import { runTerminal } from './tui.ts'
import { createTerminalController } from './terminal-controller.ts'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PiRuntime } from './runtime.ts'
import { GitHubSource, FeishuSource } from './sources.ts'
import { startServer } from './server.ts'

const readVersion = (): string => {
  // Resolved from source (src/pi/*.ts) and from the bundled output (dist/*.js).
  for (const path of ['../../package.json', '../package.json']) {
    try {
      const data = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { name?: string; version?: string }
      if (data.name === 'pi-superagent' && data.version) return data.version
    } catch {}
  }
  return '0.0.0'
}

const version = readVersion()

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string', default: '.pi-superagent' },
  cwd: { type: 'string', default: process.cwd() },
  config: { type: 'string' },
  repository: { type: 'string' },
  bot: { type: 'string' },
  allowed: { type: 'string' },
  port: { type: 'string', default: '8787' },
  direct: { type: 'boolean', default: false },
  plain: { type: 'boolean', default: false },
  'allow-shell': { type: 'boolean', default: false },
  print: { type: 'boolean', short: 'p', default: false },
  continue: { type: 'boolean', short: 'c', default: false },
  session: { type: 'string' },
  version: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h' },
} })

async function main(): Promise<void> {
  const first = positionals[0]
  const commands = ['run', 'serve', 'status', 'stop', 'retry', 'chat', 'help']
  const command = first && commands.includes(first) ? first : 'chat'
  if (values.version) { console.log(`pi-superagent ${version}`); return }
  if (values.help || command === 'help') {
    console.log('pi-superagent ["任务"]：pi 风格交互式 coding CLI 工单 TUI（真实终端）\n--direct 当前目录编码；--plain 纯文本；-p 单次输出\n评估/授权/工单/执行/队列/待人工：实时状态\npi-superagent -p "任务"：单次输出；-c：恢复当前目录会话\npi-superagent run "任务" | serve | status | stop <ticket> | retry <ticket>\n--cwd <目录> --session <会话JSON> --allow-shell（非沙箱）\n工单模式：--state <状态目录> --config <配置JSON>\nserve: --repository owner/repo --bot 用户名 --allowed 用户1,用户2\n模型：OPENAI_BASE_URL、OPENAI_MODEL、OPENAI_API_KEY；面板：PI_SUPERAGENT_TOKEN')
    return
  }
  if (command === 'chat') {
    if (process.stdin.isTTY && process.stdout.isTTY && !values.print && !values.plain) {
      if (values.repository || values.bot || values.allowed) throw new Error('TUI 平台监听请使用 serve，终端工单使用 --config')
      if (values.session) throw new Error('TUI 使用 --state 存储工单与会话，JSON --session 仅用于 --plain')
      const controller = await createTerminalController({ cwd: resolve(values.cwd!), stateDir: resolve(values.state!),
        allowShell: values['allow-shell'], resume: values.continue, mode: values.direct ? 'coding' : 'tickets',
        config: values.config ? JSON.parse(readFileSync(resolve(values.config), 'utf8')) : undefined })
      try {
        await runTerminal(controller, { initialPrompt: (first === 'chat' ? positionals.slice(1) : positionals).join(' ') || undefined })
      } finally { await controller.close() }
      return
    }
    if (values.config || values.repository || values.bot || values.allowed) throw new Error('纯文本 coding 模式不接受服务配置，请使用 run 或 serve')
    const cwd = resolve(values.cwd!)
    const workspace = createHash('sha256').update(cwd).digest('hex').slice(0, 24)
    await runCoding({ cwd, sessionPath: values.session ? resolve(values.session) : resolve(homedir(), '.pi-superagent', 'sessions', `${workspace}.json`),
      resume: values.continue, print: values.print, allowShell: values['allow-shell'],
      prompt: (first === 'chat' ? positionals.slice(1) : positionals).join(' ') || undefined })
    return
  }
  if (values.print || values.continue || values.session || values.direct || values.plain) throw new Error('-p、-c、--session、--direct、--plain 仅用于聊天模式')
  if (command === 'run' && !positionals.slice(1).join(' ').trim()) throw new Error('run 必须提供任务文本')
  if (['status', 'stop', 'retry'].includes(command) && process.env.PI_SUPERAGENT_TOKEN) {
    if (command !== 'status' && !positionals[1]) throw new Error('必须提供工单 ID')
    const endpoint = command === 'status' ? '/api/tickets' : `/api/tickets/${encodeURIComponent(positionals[1]!)}/${command}`
    let response: Response | undefined
    try {
      response = await fetch(`http://127.0.0.1:${Number(values.port)}${endpoint}`, {
        method: command === 'status' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${process.env.PI_SUPERAGENT_TOKEN}`, 'Content-Type': 'application/json' },
        ...(command === 'status' ? {} : { body: '{}' }), signal: AbortSignal.timeout(5000), redirect: 'error',
      })
    } catch { }
    if (response) {
      if (!response.ok) throw new Error('管理 API 拒绝请求，请检查令牌、端口和工单状态')
      console.log(JSON.stringify(await response.json(), null, 2)); return
    }
  }
  const runtime = new PiRuntime({ stateDir: resolve(values.state!), repositoryDirectory: resolve(values.cwd!), allowShell: values['allow-shell'] })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    if (values.config) runtime.configure(JSON.parse(readFileSync(resolve(values.config), 'utf8')))
    runtime.register({ id: 'local', send: async message => { console.log(message.text) } })
    if (values.repository) {
      if (!values.bot) throw new Error('GitHub Source 必须提供 --bot')
      runtime.register(new GitHubSource({ store: runtime.store, receive: trigger => runtime.receive(trigger), repository: values.repository, botUsername: values.bot,
        closed: event => runtime.engine.threadClosed(event.thread, event.outcome, event.at) }))
    }
    const settings = runtime.store.settings()
    if (command === 'run' && !values.config && !settings.policy.sources.local) {
      runtime.configure({ ...settings, policy: { ...settings.policy,
        rules: settings.policy.rules.length ? [...settings.policy.rules, ...(settings.policy.rules.some(rule => rule.id === 'requested') ? [] : [{ id: 'requested', name: '本地明确任务', enabled: true, instruction: '仅执行本地操作者明确提出且目标确定的编码任务。超出任务的工作不授权。' }])] : [],
        sources: { ...settings.policy.sources, local: { allowed: [{ id: 'operator' }] } } } })
    }
    if (values.allowed) {
      const current = runtime.store.settings()
      runtime.configure({ ...current, policy: { ...current.policy, sources: { ...current.policy.sources,
        github: { ...current.policy.sources.github, allowed: values.allowed.split(',').map(id => ({ id: id.trim() })).filter(person => person.id) } } } })
    }
    let feishu: FeishuSource | undefined
    if (process.env.FEISHU_BOT_ID) {
      feishu = new FeishuSource({ store: runtime.store, receive: trigger => runtime.receive(trigger), botId: process.env.FEISHU_BOT_ID,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? '' })
      runtime.register(feishu)
    }
    if (command === 'status') { console.log(JSON.stringify(runtime.status(), null, 2)); return }
    if (command === 'stop' || command === 'retry') {
      if (!positionals[1]) throw new Error('必须提供工单 ID')
      if (command === 'stop') runtime.engine.stopTicket(positionals[1])
      else runtime.engine.retryTicket(positionals[1])
      console.log('已记录，serve 启动后处理'); return
    }
    if (command === 'run') {
      runtime.start()
      const triggerId = runtime.submit(positionals.slice(1).join(' '))
      await runtime.idle()
      const decision = runtime.store.triggers.disposition(triggerId)?.decisionId
      const record = decision ? runtime.store.decisions.get(decision) : undefined
      const ticket = record?.ticketId ? runtime.store.tickets.get(record.ticketId) : undefined
      console.log(JSON.stringify(ticket ? { id: ticket.id, directory: ticket.execution?.directory, outcome: ticket.ended?.outcome,
        report: ticket.assignments.at(-1)?.report } : record ?? { status: 'pending' }, null, 2))
      if (!ticket?.ended || ticket.ended.outcome !== 'completed') process.exitCode = 1
      return
    }
    if (!process.env.PI_SUPERAGENT_TOKEN) throw new Error('serve 必须设置 PI_SUPERAGENT_TOKEN')
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口')
    runtime.start()
    server = await startServer({ store: runtime.store, health: () => runtime.health(), receive: trigger => runtime.receive(trigger),
      stopTicket: id => runtime.engine.stopTicket(id), retryTicket: id => runtime.engine.retryTicket(id), pause: paused => runtime.pause(paused) },
    { port, token: process.env.PI_SUPERAGENT_TOKEN, ...(feishu ? { feishuEvent: (body: unknown) => feishu!.handleEvent(body) } : {}) })
    const address = server.address()
    const actualPort = address && typeof address !== 'string' ? address.port : port
    console.log(`面板：http://127.0.0.1:${actualPort}；API 需 Bearer token；Shell ${values['allow-shell'] ? '已启用（非沙箱）' : '已关闭'}`)
    await new Promise<void>(resolveStop => {
      process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop)
    })
  } finally {
    if (server) await new Promise<void>((resolveClose, reject) => server!.close(error => error ? reject(error) : resolveClose()))
    await runtime.close()
  }
}

main().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  console.error(code === 'ELOCKED' ? 'serve 正在使用该状态目录，请通过面板操作，或停止 serve 后重试。'
    : error instanceof Error && (error.message.startsWith('pi 宿主') || error.message.startsWith('缺少环境变量') || error.message.startsWith('编码助手运行失败')) ? error.message
      : '启动或执行失败，请检查参数、配置、接口凭据和状态目录。')
  process.exitCode = 1
})
