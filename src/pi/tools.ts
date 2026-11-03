import { spawn } from 'node:child_process'
import { constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import { bool, int, obj, opt, str, type Schema } from '@earendil-works/pi-schema'
import { z } from 'zod'

export interface CodingToolsOptions {
  allowShell?: boolean
  blockedCommands?: string[]
}

const OUTPUT_LIMIT = 32768
const FILE_LIMIT = 1048576
const ENTRY_LIMIT = 10000
const RESULT_LIMIT = 200
const DEFAULT_TIMEOUT = 30000
const MAX_TIMEOUT = 120000
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
const REDACTED = '[凭据已隐藏]'
const pathSchema = str({ minLength: 1, description: '相对于工作目录的路径，禁止越界、符号链接及凭据文件；允许 .env.example。' })
const pathInput = z.string().min(1).refine(value => !value.includes('\0'))

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('操作已取消。')
}

function secretValues(): string[] {
  return [...new Set(Object.entries(process.env).filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length > 0).map(([, value]) => value!))].sort((a, b) => b.length - a.length)
}

function redactText(text: string, secrets: readonly string[]): string {
  if (!secrets.length) return text
  const pattern = secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return text.replace(new RegExp(pattern, 'g'), () => REDACTED)
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), redactValue(item, secrets)]))
  }
  return value
}

function secretFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env.example') return false
  return lower === '.env' || lower.startsWith('.env.') || /^(?:\.?auth|\.?credentials?|\.?secrets?)(?:[._-].*)?$/.test(lower)
    || ['.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', 'hosts.yml', 'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'].includes(lower)
    || /\.(?:pem|p12|pfx|key)$/.test(lower)
}

function childEnvironment(): NodeJS.ProcessEnv {
  const secrets = secretValues()
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    !SECRET_NAME.test(name) && !['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4'].includes(name.toUpperCase())
    && !name.startsWith('BASH_FUNC_') && value !== undefined
    && (name === 'PATH' || name === 'HOME' || !secrets.some(secret => value.includes(secret)))))
}

function result(text: string, details: Record<string, JsonValue> = {}): AgentToolResult {
  return { content: [{ type: 'text', text }], details }
}

function sanitizeResult(value: AgentToolResult, secrets: readonly string[]): AgentToolResult {
  let truncated = false
  const content = value.content.map(part => {
    if (part.type !== 'text') return part
    const text = redactText(part.text, secrets)
    if (Buffer.byteLength(text) <= OUTPUT_LIMIT) return { ...part, text }
    truncated = true
    return { ...part, text: `${Buffer.from(text).subarray(0, OUTPUT_LIMIT - 64).toString('utf8')}\n输出已截断。` }
  })
  const details = redactValue(value.details, secrets) as Record<string, unknown>
  return { ...value, content, details: { ...details, truncated: truncated || details.truncated === true } }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function tool<T>(name: string, label: string, description: string, parameters: Schema<T>, input: z.ZodType<T>, execute: (args: T, signal: AbortSignal | undefined, secrets: readonly string[]) => Promise<AgentToolResult>): AgentTool {
  const initialSecrets = secretValues()
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      const secrets = [...new Set([...initialSecrets, ...secretValues()])].sort((a, b) => b.length - a.length)
      cancelled(signal)
      const parsed = input.safeParse(params)
      if (!parsed.success) throw new Error(redactText(`工具 ${name} 参数无效，请检查字段及取值范围。`, secrets))
      try {
        const value = await execute(parsed.data, signal, secrets)
        return sanitizeResult(value, [...new Set([...secrets, ...secretValues()])].sort((a, b) => b.length - a.length))
      } catch (error) {
        const currentSecrets = [...new Set([...secrets, ...secretValues()])].sort((a, b) => b.length - a.length)
        if (signal?.aborted) throw new Error(redactText('操作已取消。', currentSecrets))
        if (error instanceof Error && !('code' in error)) throw new Error(redactText(error.message, currentSecrets))
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '未知错误'
        throw new Error(redactText(`工具 ${name} 操作失败（${code}）。`, currentSecrets))
      }
    },
  }
}

export function codingTools(cwd: string, options: CodingToolsOptions = {}): AgentTool[] {
  let root: string
  try {
    root = realpathSync(cwd)
    if (!statSync(root).isDirectory()) throw new Error()
  } catch {
    throw new Error('工作目录必须是存在且可访问的目录。')
  }
  const blocked = (options.blockedCommands ?? []).map(value => value.trim()).filter(Boolean)

  async function safePath(path: string, signal?: AbortSignal, createParents = false): Promise<string> {
    cancelled(signal)
    const target = resolve(root, path)
    if (!within(root, target)) throw new Error('拒绝访问：路径超出工作目录。')
    if (await realpath(root) !== root) throw new Error('拒绝访问：工作目录已发生变化。')
    const parts = relative(root, target).split(sep).filter(Boolean)
    if (parts.some(secretFile)) throw new Error('拒绝访问：路径包含凭据文件或目录。')
    let current = root
    for (let index = 0; index < parts.length; index++) {
      cancelled(signal)
      current = join(current, parts[index]!)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('拒绝访问：路径包含符号链接。')
        if (!within(root, await realpath(current))) throw new Error('拒绝访问：真实路径超出工作目录。')
        if (index < parts.length - 1 && !info.isDirectory()) throw new Error('拒绝访问：父路径不是目录。')
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
        if (index < parts.length - 1 && createParents) {
          cancelled(signal)
          await mkdir(current)
          const info = await lstat(current)
          if (info.isSymbolicLink() || !within(root, await realpath(current))) throw new Error('拒绝访问：父目录路径不安全。')
        } else if (index < parts.length - 1) {
          throw new Error('父目录不存在。')
        }
      }
    }
    cancelled(signal)
    return target
  }

  async function readText(path: string, signal?: AbortSignal): Promise<string> {
    const target = await safePath(path, signal)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('只能读取普通文件。')
      if (info.size > FILE_LIMIT) throw new Error('文件超过 1 MiB 读取限制。')
      const buffer = Buffer.alloc(FILE_LIMIT + 1)
      let length = 0
      while (length <= FILE_LIMIT) {
        cancelled(signal)
        const chunk = await handle.read(buffer, length, buffer.length - length, length)
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      cancelled(signal)
      if (length > FILE_LIMIT) throw new Error('文件超过 1 MiB 读取限制。')
      return buffer.subarray(0, length).toString('utf8')
    } finally {
      await handle.close()
    }
  }

  async function saveText(path: string, content: string, signal?: AbortSignal): Promise<void> {
    if (Buffer.byteLength(content) > FILE_LIMIT) throw new Error('文件超过 1 MiB 写入限制。')
    const target = await safePath(path, signal, true)
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('只能写入普通文件。')
      if (info.nlink > 1) throw new Error('拒绝写入：文件存在硬链接。')
      cancelled(signal)
      await handle.truncate(0)
      const buffer = Buffer.from(content)
      let position = 0
      while (position < buffer.length) {
        cancelled(signal)
        const chunk = await handle.write(buffer, position, buffer.length - position, position)
        if (!chunk.bytesWritten) throw new Error('文件写入未能继续。')
        position += chunk.bytesWritten
      }
      cancelled(signal)
    } finally {
      await handle.close()
    }
  }

  async function* files(path: string, signal?: AbortSignal): AsyncGenerator<string> {
    const start = await safePath(path, signal)
    let visited = 0
    async function* walk(directory: string): AsyncGenerator<string> {
      cancelled(signal)
      await safePath(directory, signal)
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        cancelled(signal)
        if (++visited > ENTRY_LIMIT) throw new Error('搜索超过 10000 个目录项限制，请缩小路径范围。')
        if (entry.isSymbolicLink() || secretFile(entry.name)) continue
        const full = await safePath(join(directory, entry.name), signal)
        if (entry.isDirectory()) yield* walk(full)
        else if (entry.isFile()) yield full
      }
    }
    const info = await lstat(start)
    if (info.isFile()) yield start
    else if (info.isDirectory()) yield* walk(start)
    else throw new Error('搜索路径必须是普通文件或目录。')
  }

  const tools: AgentTool[] = [
    tool('read', '读取文件', '读取工作目录内 UTF-8 文件，最多 1 MiB，输出最多 32 KiB；offset 从 1 开始，limit 为行数。',
      obj({ path: pathSchema, offset: opt(int({ minimum: 1 })), limit: opt(int({ minimum: 1, maximum: 1000 })) }),
      z.object({ path: pathInput, offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async ({ path, offset = 1, limit = 200 }, signal) => {
        const text = await readText(path, signal)
        const lines = text.split('\n')
        const selected = lines.slice(offset - 1, offset - 1 + limit)
        return result(selected.map((line, index) => `${offset + index}\t${line}`).join('\n'), { path, totalLines: lines.length, offset, truncated: offset - 1 + selected.length < lines.length })
      }),
    tool('write', '写入文件', '写入工作目录内 UTF-8 文件，覆盖已有内容，自动创建父目录，最多 1 MiB。',
      obj({ path: pathSchema, content: str({ maxLength: FILE_LIMIT }) }), z.object({ path: pathInput, content: z.string().max(FILE_LIMIT) }),
      async ({ path, content }, signal) => {
        await saveText(path, content, signal)
        return result('文件已写入。', { path, bytes: Buffer.byteLength(content) })
      }),
    tool('edit', '精确编辑', '用 newText 替换唯一匹配的 oldText；未匹配或多次匹配时拒绝修改。',
      obj({ path: pathSchema, oldText: str({ minLength: 1, maxLength: FILE_LIMIT }), newText: str({ maxLength: FILE_LIMIT }) }),
      z.object({ path: pathInput, oldText: z.string().min(1).max(FILE_LIMIT), newText: z.string().max(FILE_LIMIT) }),
      async ({ path, oldText, newText }, signal) => {
        const text = await readText(path, signal)
        const index = text.indexOf(oldText)
        if (index < 0) throw new Error('编辑失败：未找到 oldText。')
        if (text.indexOf(oldText, index + 1) >= 0) throw new Error('编辑失败：oldText 匹配不唯一。')
        await saveText(path, text.slice(0, index) + newText + text.slice(index + oldText.length), signal)
        return result('文件已编辑。', { path })
      }),
    tool('glob', '查找文件', '按 glob 模式查找文件，支持 **、*、?，跳过符号链接；最多返回 200 个结果、32 KiB。',
      obj({ pattern: str({ minLength: 1, maxLength: 1024 }), path: opt(pathSchema) }),
      z.object({ pattern: z.string().min(1).max(1024), path: pathInput.optional() }),
      async ({ pattern, path = '.' }, signal) => {
        if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new Error('查找模式不能超出工作目录。')
        const found: string[] = []
        for await (const file of files(path, signal)) {
          const name = relative(root, file).split(sep).join('/')
          if (matchesGlob(name, pattern)) {
            if (found.length === RESULT_LIMIT) return result(found.join('\n'), { truncated: true })
            found.push(name)
          }
        }
        return result(found.join('\n') || '未找到匹配文件。', { matches: found.length })
      }),
    tool('grep', '搜索文本', '按字面文本搜索 UTF-8 文件，非正则表达式；跳过符号链接、大文件及二进制文件，最多 200 行、32 KiB。',
      obj({ pattern: str({ minLength: 1, maxLength: 4096 }), path: opt(pathSchema), ignoreCase: opt(bool()) }),
      z.object({ pattern: z.string().min(1).max(4096), path: pathInput.optional(), ignoreCase: z.boolean().optional() }),
      async ({ pattern, path = '.', ignoreCase = false }, signal) => {
        const found: string[] = []
        const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern
        for await (const file of files(path, signal)) {
          cancelled(signal)
          if ((await lstat(file)).size > FILE_LIMIT) continue
          const text = await readText(file, signal)
          if (text.includes('\0')) continue
          const lines = text.split('\n')
          for (let index = 0; index < lines.length; index++) {
            cancelled(signal)
            const line = lines[index]!
            if ((ignoreCase ? line.toLocaleLowerCase() : line).includes(needle)) {
              if (found.length === RESULT_LIMIT) return result(found.join('\n'), { truncated: true })
              found.push(`${relative(root, file)}:${index + 1}:${line}`)
            }
          }
        }
        return result(found.join('\n') || '未找到匹配文本。', { matches: found.length })
      }),
  ]

  if (options.allowShell === true) {
    tools.push(tool('bash', '执行命令（非沙箱）', '在工作目录执行 bash。非沙箱：保留 PATH/HOME，仍可读取 HOME、目录外文件、系统钥匙串及访问网络；黑名单不能提供安全隔离。名字匹配 KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL 的环境变量不传给子进程，不支持依赖 GH_TOKEN/GITHUB_TOKEN 的容器认证，gh 系统钥匙串认证可继续使用。输出仅对已知环境凭据值脱敏，不保证阻止编码或未知文件凭据泄露。默认超时 30 秒，最长 120 秒，输出最多 32 KiB。',
      obj({ command: str({ minLength: 1, maxLength: 16384 }), timeoutMs: opt(int({ minimum: 1, maximum: MAX_TIMEOUT })) }),
      z.object({ command: z.string().min(1).max(16384), timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT).optional() }),
      async ({ command, timeoutMs = DEFAULT_TIMEOUT }, signal, secrets) => {
        if (blocked.some(value => command.toLocaleLowerCase().includes(value.toLocaleLowerCase()))) {
          throw new Error('拒绝执行：命令匹配禁止命令列表。')
        }
        await safePath('.', signal)
        if (lstatSync(root).isSymbolicLink()) throw new Error('拒绝执行：工作目录包含符号链接。')
        cancelled(signal)
        const env = childEnvironment()
        const captureLimit = OUTPUT_LIMIT + Math.max(0, ...secrets.map(value => Buffer.byteLength(value)))
        return await new Promise<AgentToolResult>((resolveResult, reject) => {
          const child = spawn('bash', ['--noprofile', '--norc', '-c', command], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
          const chunks: Buffer[] = []
          let size = 0
          let truncated = false
          let failure: Error | undefined
          let settled = false
          const collect = (chunk: Buffer) => {
            const remaining = captureLimit - size
            if (chunk.length > remaining) truncated = true
            if (remaining > 0) {
              const part = chunk.subarray(0, remaining)
              chunks.push(part)
              size += part.length
            }
          }
          const kill = () => {
            try {
              if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
              else child.kill('SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
          const stop = (error: Error) => {
            failure ??= error
            kill()
          }
          const abort = () => stop(new Error('操作已取消。'))
          const timer = setTimeout(() => stop(new Error(`命令执行超时（${timeoutMs} 毫秒）。`)), timeoutMs)
          const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
          child.stdout.on('data', collect)
          child.stderr.on('data', collect)
          child.once('error', () => {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error('无法启动 bash 命令。'))
          })
          child.once('close', (code, exitSignal) => {
            if (settled) return
            settled = true
            cleanup()
            kill()
            if (failure) return reject(failure)
            const text = Buffer.concat(chunks).toString('utf8')
            resolveResult({
              ...result(`${text}${truncated ? '\n输出已截断。' : ''}` || '命令执行完成。', { exitCode: code, signal: exitSignal, truncated, sandbox: false }),
              isError: code !== 0,
            })
          })
        })
      }))
  }
  return tools
}
