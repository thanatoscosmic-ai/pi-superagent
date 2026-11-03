import { randomUUID, createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import { z } from 'zod'
import { createPiAgent, type CreatePiAgentOptions } from './model.js'
import { codingTools } from './tools.js'

const SESSION_LIMIT = 8 * 1024 * 1024
const TIMEOUT = 30 * 60 * 1000
const MAX_TURNS = 100
const HIDDEN = '[凭据已隐藏]'
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i
const help = '/exit 退出；/help 帮助；/new 清空上下文；/status 状态；/shell on|off 开关命令执行。Ctrl+C 取消当前轮，空闲时退出。'
const shellWarning = '警告：shell 已开启，命令执行非沙箱，可访问目录外文件、HOME、系统钥匙串和网络；已知环境秘密脱敏不等于安全隔离。\n'
const contentPart = z.union([
  z.object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), thinkingSignature: z.string().optional(), redacted: z.boolean().optional() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
])
const usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(), cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }) })
const sessionSchema = z.object({
  cwd: z.string(),
  messages: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(contentPart)]), timestamp: z.number() }),
    z.object({ role: z.literal('assistant'), content: z.array(contentPart), api: z.string(), provider: z.string(), model: z.string(), usage, stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']), errorMessage: z.string().optional(), timestamp: z.number() }),
    z.object({ role: z.literal('toolResult'), toolCallId: z.string(), toolName: z.string(), content: z.array(contentPart), details: z.unknown().optional(), isError: z.boolean(), timestamp: z.number() }),
  ])),
})

export interface CodingOptions {
  cwd: string
  sessionPath?: string
  resume?: boolean
  prompt?: string
  print?: boolean
  allowShell?: boolean
  agentFactory?: (options: CreatePiAgentOptions) => Agent
  input?: Readable
  output?: Writable
}

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function safeSession(path: string, create: boolean): Promise<void> {
  let current = parse(path).root
  const parts = relative(current, path).split(sep)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index] ?? '')
    let info: Stats
    try {
      info = await lstat(current)
    } catch (error) {
      if (!missing(error)) throw error
      if (index === parts.length - 1) return
      if (!create) throw error
      try { await mkdir(current, { mode: 0o700 }) } catch (failure) {
        if (!failure || typeof failure !== 'object' || !('code' in failure) || failure.code !== 'EEXIST') throw failure
      }
      info = await lstat(current)
    }
    if (info.isSymbolicLink()) throw new Error('拒绝会话文件：路径包含符号链接。')
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) {
      throw new Error('拒绝会话文件：路径不是安全的普通文件或目录。')
    }
  }
}

function systemPrompt(cwd: string, allowShell: boolean): string {
  return `你是用户当前项目的中文编码助手。工作目录：${cwd}。直接在此目录编辑，不创建 worktree。先读取相关代码、理解现有结构再修改，只完成用户要求。完成后运行相关测试；无法测试时明确说明原因，不得声称测试通过。不要额外提交或推送 Git。禁止读取或输出凭据及秘密。${allowShell ? 'shell 已获用户授权，但非沙箱；不要越出任务范围。' : 'shell 默认关闭，不能执行命令；需要测试时说明限制，并请用户通过 /shell on 明确授权。'}用中文简洁报告修改、测试和限制。`
}

function updatePrompt(agent: Agent, prompt: string): void {
  const compatible = agent as Agent & { setSystemPrompt?: (value: string) => void }
  if (compatible.setSystemPrompt) compatible.setSystemPrompt(prompt)
  else agent.state.messages = [{ role: 'system', content: prompt, timestamp: Date.now() }, ...agent.state.messages.filter(message => message.role !== 'system')]
}

export async function runCoding(options: CodingOptions): Promise<void> {
  const secrets = new Set<string>()
  const collectSecrets = () => {
    for (const [name, value] of Object.entries(process.env)) {
      if (SECRET_NAME.test(name) && value) secrets.add(value)
    }
    return [...secrets].sort((a, b) => b.length - a.length)
  }
  const redact = (text: string) => {
    const values = collectSecrets()
    if (!values.length) return text
    return text.replace(new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), () => HIDDEN)
  }
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credentials?|authorization|cookie)$/i.test(key)).map(([key, item]) => [redact(key), sanitize(item)]))
    return value
  }
  collectSecrets()
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const terminal = (input as Readable & { isTTY?: boolean }).isTTY === true && !options.print
  const write = (text: string) => { output.write(redact(text)) }
  let agent: Agent | undefined
  let unsubscribe: (() => void) | undefined
  let readline: ReturnType<typeof createInterface> | undefined
  let active = false
  let exiting = false
  let cancelled = false
  let limitError: string | undefined
  let pendingText = ''
  const flushText = (end = false) => {
    pendingText = redact(pendingText)
    const values = collectSecrets()
    let keep = 0
    if (!end) for (const secret of values) {
      for (let size = 1; size < secret.length && size <= pendingText.length; size++) {
        if (pendingText.endsWith(secret.slice(0, size))) keep = Math.max(keep, size)
      }
    }
    const ready = pendingText.slice(0, pendingText.length - keep)
    pendingText = pendingText.slice(pendingText.length - keep)
    if (ready) write(ready)
  }
  const interrupt = () => {
    if (active) {
      cancelled = true
      agent?.abort()
      if (!options.print) write('\n正在取消当前轮……\n')
    } else {
      exiting = true
      readline?.close()
    }
  }
  try {
    const cwd = await realpath(options.cwd)
    if (!(await lstat(cwd)).isDirectory()) throw new Error('工作目录必须是目录。')
    const sessionPath = options.sessionPath ? resolve(cwd, options.sessionPath) : join(await realpath(homedir()), '.pi-superagent', 'sessions', `${createHash('sha256').update(cwd).digest('hex')}.json`)
    await safeSession(sessionPath, !options.resume)
    let messages: AgentMessage[] = []
    if (options.resume) {
      const handle = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1) throw new Error('拒绝恢复：会话文件不安全。')
        if (info.size > SESSION_LIMIT) throw new Error('拒绝恢复：会话超过 8 MiB 限制。')
        const buffer = Buffer.alloc(SESSION_LIMIT + 1)
        let length = 0
        while (length < buffer.length) {
          const chunk = await handle.read(buffer, length, buffer.length - length, length)
          if (!chunk.bytesRead) break
          length += chunk.bytesRead
        }
        if (length > SESSION_LIMIT) throw new Error('拒绝恢复：会话超过 8 MiB 限制。')
        const saved = sessionSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')))
        if (saved.cwd !== cwd) throw new Error('拒绝恢复：会话 cwd 与当前工作目录不匹配。')
        messages = saved.messages as AgentMessage[]
      } finally { await handle.close() }
    }
    let allowShell = options.allowShell === true
    const prompt = systemPrompt(cwd, allowShell)
    agent = (options.agentFactory ?? createPiAgent)({ cwd, systemPrompt: prompt, tools: codingTools(cwd, { allowShell }), messages })
    updatePrompt(agent, prompt)
    const currentAgent = agent
    const save = async () => {
      const conversation = sessionSchema.parse({ cwd, messages: currentAgent.state.messages.filter(message => message.role !== 'system') })
      const data = `${JSON.stringify(sanitize(conversation))}\n`
      if (Buffer.byteLength(data) > SESSION_LIMIT) throw new Error('会话超过 8 MiB 保存限制。')
      await safeSession(sessionPath, true)
      const temporary = join(dirname(sessionPath), `.${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await handle.chmod(0o600)
          await handle.writeFile(data)
          await handle.sync()
        } finally { await handle.close() }
        await safeSession(sessionPath, false)
        await rename(temporary, sessionPath)
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
    }
    let turns = 0
    unsubscribe = currentAgent.subscribe(async event => {
      if (event.type === 'turn_start') turns++
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && !options.print) {
        pendingText += event.assistantMessageEvent.delta
        flushText()
      }
      if (event.type === 'message_end') {
        if (!options.print && event.message.role === 'assistant') {
          flushText(true)
          write('\n')
        }
        await save()
      }
      if (!options.print && event.type === 'tool_execution_start') write(`\n工具开始：${currentAgent.state.tools.find(tool => tool.name === event.toolName)?.label ?? event.toolName}\n`)
      if (!options.print && event.type === 'tool_execution_end') write(`工具${event.isError ? '失败' : '完成'}：${currentAgent.state.tools.find(tool => tool.name === event.toolName)?.label ?? event.toolName}\n`)
    })
    const previousPrepare = currentAgent.prepareRequest
    currentAgent.prepareRequest = async (request, signal) => {
      if (turns > MAX_TURNS) {
        limitError = '当前轮超过 100 次模型调用限制。'
        currentAgent.abort()
        throw new Error(limitError)
      }
      return (await previousPrepare?.(request, signal)) ?? undefined
    }
    process.on('SIGINT', interrupt)
    if (allowShell) {
      if (options.print) process.stderr.write(redact(shellWarning))
      else write(shellWarning)
    }
    const run = async (text: string) => {
      if (!text.trim() || exiting) return
      active = true
      cancelled = false
      limitError = undefined
      turns = 0
      const start = currentAgent.state.messages.length
      const timer = setTimeout(() => {
        limitError = '当前轮超过 30 分钟时间限制。'
        currentAgent.abort()
      }, TIMEOUT)
      try {
        await currentAgent.prompt(text)
        if (limitError) throw new Error(limitError)
        const responses = currentAgent.state.messages.slice(start).filter(message => message.role === 'assistant')
        const last = responses.at(-1)
        if (!cancelled && last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) throw new Error(last.errorMessage ?? '模型未能完成响应。')
        if (!cancelled && currentAgent.state.errorMessage) throw new Error(currentAgent.state.errorMessage)
        if (options.print && last?.role === 'assistant' && !cancelled) write(`${last.content.filter(part => part.type === 'text').map(part => part.text).join('')}\n`)
        if (cancelled && !options.print) write('当前轮已取消。\n')
      } catch (error) {
        if (!cancelled || limitError) throw error
        if (!options.print) write('当前轮已取消。\n')
      } finally {
        clearTimeout(timer)
        active = false
        flushText(true)
      }
    }
    if (options.prompt !== undefined) {
      await run(options.prompt)
      if (!terminal || options.print) return
    }
    readline = createInterface({ input, output: terminal ? output : undefined, terminal, crlfDelay: Infinity })
    readline.on('SIGINT', interrupt)
    const lines = readline[Symbol.asyncIterator]()
    if (options.print) {
      const parts: string[] = []
      for await (const line of { [Symbol.asyncIterator]: () => lines }) parts.push(line)
      await run(parts.join('\n'))
      return
    }
    if (terminal) {
      write(`中文编码助手：直接编辑 ${cwd}，shell ${allowShell ? '开启（非沙箱）' : '关闭'}。\n${help}\n`)
      readline.setPrompt('你> ')
      readline.prompt()
    }
    for await (const line of { [Symbol.asyncIterator]: () => lines }) {
      if (exiting) break
      const command = line.trim()
      if (command === '/exit') break
      if (command === '/help') write(`${help}\n`)
      else if (command === '/status') write(`目录：${cwd}\n会话：${sessionPath}\n消息数：${currentAgent.state.messages.filter(message => message.role !== 'system').length}\nshell：${allowShell ? '开启（非沙箱）' : '关闭'}\n状态：空闲\n`)
      else if (command === '/new') {
        currentAgent.reset()
        updatePrompt(currentAgent, systemPrompt(cwd, allowShell))
        await save()
        write('已开始新会话，上下文已清空。\n')
      } else if (command === '/shell on' || command === '/shell off') {
        allowShell = command === '/shell on'
        currentAgent.state.tools = codingTools(cwd, { allowShell })
        updatePrompt(currentAgent, systemPrompt(cwd, allowShell))
        write(allowShell ? shellWarning : 'shell 已关闭。\n')
      } else if (command.startsWith('/')) write(`未知命令。${help}\n`)
      else await run(line)
      if (terminal && !exiting) readline.prompt()
    }
  } catch (error) {
    const text = error instanceof z.ZodError ? '会话 JSON 结构无效。' : error instanceof SyntaxError ? '会话 JSON 无效。' : error instanceof Error ? error.message : String(error)
    throw new Error(redact(`编码助手运行失败：${text}`))
  } finally {
    process.removeListener('SIGINT', interrupt)
    readline?.removeListener('SIGINT', interrupt)
    readline?.close()
    unsubscribe?.()
  }
}
