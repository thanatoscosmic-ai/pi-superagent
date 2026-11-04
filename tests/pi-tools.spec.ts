import * as fsPromises from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { codingTools } from '../src/pi/tools.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

let parent: string
let cwd: string
let outside: string
let tools: AgentTool[]

function call(name: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
  const selected = tools.find(tool => tool.name === name)
  if (!selected) throw new Error(`未找到工具 ${name}`)
  return selected.execute('test-call', args, signal)
}

function text(value: AgentToolResult): string {
  return value.content.map(part => part.type === 'text' ? part.text : '').join('\n')
}

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'pi-tools-'))
  cwd = join(parent, 'workspace')
  outside = join(parent, 'outside')
  await mkdir(cwd)
  await mkdir(outside)
  tools = codingTools(cwd)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(parent, { recursive: true, force: true })
})

describe('文件工具', () => {
  it('默认仅提供五个文件工具，显式开启 bash 并声明非沙箱', () => {
    expect(tools.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'glob', 'grep'])
    const shell = codingTools(cwd, { allowShell: true }).find(tool => tool.name === 'bash')
    expect(shell?.description).toContain('非沙箱')
  })

  it('写入、读取、覆盖及精确编辑临时文件', async () => {
    await call('write', { path: 'nested/demo.txt', content: '第一行\n第二行\n第三行' })
    expect(await readFile(join(cwd, 'nested/demo.txt'), 'utf8')).toBe('第一行\n第二行\n第三行')
    expect(text(await call('read', { path: 'nested/demo.txt', offset: 2, limit: 1 }))).toBe('2\t第二行')
    await call('edit', { path: 'nested/demo.txt', oldText: '第二行', newText: '已替换' })
    expect(text(await call('read', { path: 'nested/demo.txt' }))).toContain('2\t已替换')
    await call('write', { path: 'nested/demo.txt', content: '短' })
    expect(await readFile(join(cwd, 'nested/demo.txt'), 'utf8')).toBe('短')
  })

  it('未匹配和重复匹配不修改文件', async () => {
    await writeFile(join(cwd, 'demo.txt'), 'aaa')
    await expect(call('edit', { path: 'demo.txt', oldText: 'b', newText: 'x' })).rejects.toThrow('未找到')
    await expect(call('edit', { path: 'demo.txt', oldText: 'aa', newText: 'x' })).rejects.toThrow('不唯一')
    expect(await readFile(join(cwd, 'demo.txt'), 'utf8')).toBe('aaa')
  })

  it.each(['../outside/secret.txt', 'nested/../../outside/secret.txt'])('拒绝相对路径越界 %s', async path => {
    await writeFile(join(outside, 'secret.txt'), '秘密')
    await expect(call('read', { path })).rejects.toThrow('超出工作目录')
    await expect(call('write', { path, content: '覆盖' })).rejects.toThrow('超出工作目录')
    await expect(call('edit', { path, oldText: '秘密', newText: '覆盖' })).rejects.toThrow('超出工作目录')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('秘密')
  })

  it('拒绝绝对路径越界及相似前缀目录', async () => {
    const sibling = `${cwd}-other`
    await mkdir(sibling)
    await expect(call('write', { path: join(sibling, 'demo.txt'), content: 'x' })).rejects.toThrow('超出工作目录')
    await expect(call('read', { path: join(outside, 'secret.txt') })).rejects.toThrow('超出工作目录')
  })

  it('拒绝文件、父目录、悬空及目录内符号链接', async () => {
    await writeFile(join(outside, 'secret.txt'), '秘密')
    await writeFile(join(cwd, 'local.txt'), '内部')
    await symlink(join(outside, 'secret.txt'), join(cwd, 'file-link'))
    await symlink(outside, join(cwd, 'dir-link'))
    await symlink(join(outside, 'missing.txt'), join(cwd, 'dangling-link'))
    await symlink(join(cwd, 'local.txt'), join(cwd, 'inside-link'))
    for (const path of ['file-link', 'dir-link/local-outside.txt', 'dangling-link', 'inside-link']) {
      await expect(call('read', { path })).rejects.toThrow('符号链接')
      await expect(call('write', { path, content: '覆盖' })).rejects.toThrow('符号链接')
      await expect(call('edit', { path, oldText: '秘密', newText: '覆盖' })).rejects.toThrow('符号链接')
    }
    await expect(call('write', { path: 'dir-link/nested/new.txt', content: 'x' })).rejects.toThrow('符号链接')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('秘密')
  })

  it('工作目录入口使用 realpath', async () => {
    const alias = join(parent, 'alias')
    await symlink(cwd, alias)
    tools = codingTools(alias)
    await call('write', { path: 'test.txt', content: '真实目录' })
    expect(await readFile(join(cwd, 'test.txt'), 'utf8')).toBe('真实目录')
  })

  it('已取消的读取、写入、编辑不产生副作用', async () => {
    await writeFile(join(cwd, 'demo.txt'), '原始')
    const controller = new AbortController()
    controller.abort()
    await expect(call('read', { path: 'demo.txt' }, controller.signal)).rejects.toThrow('取消')
    await expect(call('write', { path: 'nested/new.txt', content: '新建' }, controller.signal)).rejects.toThrow('取消')
    await expect(call('edit', { path: 'demo.txt', oldText: '原始', newText: '改动' }, controller.signal)).rejects.toThrow('取消')
    expect(await readFile(join(cwd, 'demo.txt'), 'utf8')).toBe('原始')
    await expect(readFile(join(cwd, 'nested/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('文件操作执行过程中取消', async () => {
    await writeFile(join(cwd, 'demo.txt'), '原始')
    for (const [name, args] of [
      ['read', { path: 'demo.txt' }],
      ['write', { path: 'demo.txt', content: '改动' }],
      ['edit', { path: 'demo.txt', oldText: '原始', newText: '改动' }],
    ] as const) {
      const controller = new AbortController()
      const pending = call(name, args, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow('取消')
    }
    expect(await readFile(join(cwd, 'demo.txt'), 'utf8')).toBe('原始')
  })

  it('限制文件大小、输出及参数，拒绝目录读取', async () => {
    await writeFile(join(cwd, 'large.txt'), 'x'.repeat(1048577))
    await expect(call('read', { path: 'large.txt' })).rejects.toThrow('1 MiB')
    await expect(call('write', { path: 'oversize.txt', content: '中'.repeat(400000) })).rejects.toThrow('1 MiB')
    await writeFile(join(cwd, 'long.txt'), '中'.repeat(20000))
    const output = await call('read', { path: 'long.txt' })
    expect(Buffer.byteLength(text(output))).toBeLessThanOrEqual(32768)
    expect(output.details).toMatchObject({ truncated: true })
    await expect(call('read', { path: '.', offset: 0 })).rejects.toThrow('参数无效')
    await expect(call('read', { path: '.' })).rejects.toThrow('普通文件')
  })

  it('glob 和字面 grep 可用且跳过符号链接', async () => {
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src/a.ts'), 'const value = "Hello.*"\nhello')
    await writeFile(join(cwd, 'root.ts'), '根文件')
    await writeFile(join(outside, 'secret.ts'), 'Hello.* 秘密')
    await symlink(outside, join(cwd, 'linked'))
    expect(text(await call('glob', { pattern: '**/*.ts' }))).toContain('src/a.ts')
    expect(text(await call('glob', { pattern: '**/*.ts' }))).not.toContain('secret')
    expect(text(await call('grep', { pattern: 'Hello.*' }))).toBe('src/a.ts:1:const value = "Hello.*"')
    expect(text(await call('grep', { pattern: 'HELLO', ignoreCase: true }))).toContain('src/a.ts:2:hello')
    await expect(call('glob', { pattern: '../**' })).rejects.toThrow('超出工作目录')
    await expect(call('grep', { pattern: 'x', path: 'linked' })).rejects.toThrow('符号链接')
    const controller = new AbortController()
    controller.abort()
    await expect(call('glob', { pattern: '**' }, controller.signal)).rejects.toThrow('取消')
    await expect(call('grep', { pattern: 'x' }, controller.signal)).rejects.toThrow('取消')
  })
})

describe('凭据防泄露', () => {
  it.each(['.env', '.env.local', '.ENV.production', 'auth.json', 'credentials', 'credentials.json', '.credentials', 'secrets.yml', '.netrc', '.npmrc', 'id_ed25519', 'private.pem'])('所有文件工具拒绝凭据路径 %s', async name => {
    await mkdir(join(cwd, 'config'))
    const path = `config/${name}`
    await writeFile(join(cwd, path), '秘密原文')
    await expect(call('read', { path })).rejects.toThrow('凭据文件')
    await expect(call('write', { path, content: '改动' })).rejects.toThrow('凭据文件')
    await expect(call('edit', { path, oldText: '秘密原文', newText: '改动' })).rejects.toThrow('凭据文件')
    await expect(call('glob', { path, pattern: '**/*' })).rejects.toThrow('凭据文件')
    await expect(call('grep', { path, pattern: '秘密' })).rejects.toThrow('凭据文件')
    expect(await readFile(join(cwd, path), 'utf8')).toBe('秘密原文')
  })

  it('凭据路径检查在创建父目录之前完成，目录遍历跳过凭据文件和目录', async () => {
    await expect(call('write', { path: 'new/credentials/token.txt', content: '秘密' })).rejects.toThrow('凭据文件')
    await expect(readFile(join(cwd, 'new/credentials/token.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(cwd, 'credentials'))
    await writeFile(join(cwd, 'credentials/hidden.txt'), '凭据内容')
    await writeFile(join(cwd, 'auth.json'), '凭据内容')
    await writeFile(join(cwd, '.env.local'), '凭据内容')
    await call('write', { path: '.env.example', content: '公开示例内容' })
    await call('edit', { path: '.env.example', oldText: '公开示例', newText: '公开模板' })
    expect(text(await call('read', { path: '.env.example' }))).toContain('公开模板内容')
    const found = text(await call('glob', { pattern: '**/*' }))
    expect(text(await call('glob', { pattern: '.env.example' }))).toContain('.env.example')
    expect(found).not.toContain('auth.json')
    expect(found).not.toContain('credentials')
    expect(found).not.toContain('.env.local')
    expect(text(await call('grep', { pattern: '凭据内容' }))).toBe('未找到匹配文本。')
    expect(text(await call('grep', { pattern: '公开模板' }))).toContain('.env.example')
  })

  it('bash 不继承凭据或凭据别名，保留 PATH/HOME 和普通环境变量', async () => {
    const secret = '测试-凭据-a.b+$[x]-value'
    for (const name of ['OPENAI_API_KEY', 'FEISHU_APP_SECRET', 'PI_SUPERAGENT_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'test_password', 'SERVICE_CREDENTIAL', 'MONKEY']) {
      vi.stubEnv(name, secret)
    }
    vi.stubEnv('VISIBLE_ALIAS', secret)
    vi.stubEnv('BASH_ENV', join(cwd, 'startup.sh'))
    vi.stubEnv('HOME', cwd)
    vi.stubEnv('PI_PUBLIC_VALUE', '普通环境')
    await writeFile(join(cwd, 'startup.sh'), 'printf "不应加载启动文件"')
    tools = codingTools(cwd, { allowShell: true })
    const command = `for name in OPENAI_API_KEY FEISHU_APP_SECRET PI_SUPERAGENT_TOKEN GH_TOKEN GITHUB_TOKEN test_password SERVICE_CREDENTIAL MONKEY VISIBLE_ALIAS BASH_ENV; do if printenv "$name" >/dev/null; then printf '发现未过滤变量'; exit 7; fi; done; test -n "$PATH" && test -d "$HOME" && printf '%s' "$PI_PUBLIC_VALUE"`
    const output = await call('bash', { command })
    expect(text(output)).toBe('普通环境')
    expect(output.isError).toBe(false)
    expect(JSON.stringify(output)).not.toContain(secret)
    expect(tools.find(tool => tool.name === 'bash')?.description).toContain('不支持依赖 GH_TOKEN/GITHUB_TOKEN')
    expect(tools.find(tool => tool.name === 'bash')?.description).toContain('保留 PATH/HOME')
    expect(process.env.GH_TOKEN).toBe(secret)
  })

  it('读取、搜索、路径 details 和 bash 标准输出及错误输出均脱敏', async () => {
    const key = 'key-literal.a+$[x]-private'
    const token = `${key}-longer-token`
    vi.stubEnv('OPENAI_API_KEY', key)
    vi.stubEnv('PI_SUPERAGENT_TOKEN', token)
    const path = `${token}.txt`
    await writeFile(join(cwd, path), `记录 ${token} ${key}`)
    for (const output of [
      await call('read', { path }),
      await call('grep', { pattern: '记录' }),
      await call('glob', { pattern: '**/*.txt' }),
      await call('write', { path, content: `记录 ${token} ${key}` }),
      await call('edit', { path, oldText: '记录', newText: '内容' }),
    ]) {
      expect(JSON.stringify(output)).not.toContain(key)
      expect(JSON.stringify(output)).not.toContain(token)
      expect(JSON.stringify(output)).toContain('[凭据已隐藏]')
    }
    tools = codingTools(cwd, { allowShell: true })
    const output = await call('bash', { command: `printf '%s' '${token}'; printf '%s' '${key}' >&2; exit 3` })
    expect(text(output)).toBe('[凭据已隐藏][凭据已隐藏]\n[退出码 3]')
    expect(output.isError).toBe(true)
    expect(output.details).toMatchObject({ exitCode: 3 })
  })

  it('输出截断前脱敏，跨 bash 数据块和截断边界的凭据不会残留', async () => {
    const secret = 'boundary-private-token-123456'
    vi.stubEnv('OPENAI_API_KEY', secret)
    await writeFile(join(cwd, 'long.txt'), `${'x'.repeat(32760)}${secret}${'x'.repeat(500)}`)
    const read = await call('read', { path: 'long.txt' })
    expect(text(read)).not.toContain('boundary-private')
    expect(Buffer.byteLength(text(read))).toBeLessThanOrEqual(32768)
    tools = codingTools(cwd, { allowShell: true })
    const bash = await call('bash', { command: `printf '%032760d' 0; printf '%s' 'boundary-private-'; printf '%s' 'token-123456'; printf '%0500d' 0` })
    expect(text(bash)).not.toContain('boundary-private')
    expect(Buffer.byteLength(text(bash))).toBeLessThanOrEqual(32768)
    expect(bash.details).toMatchObject({ truncated: true })
  })

  it('捕获工具创建时和执行时的凭据，原始异常及错误码不泄露', async () => {
    const initial = 'initial-private-secret-value'
    const later = 'later-private-secret-value'
    vi.stubEnv('TEST_APP_SECRET', initial)
    tools = codingTools(cwd)
    vi.stubEnv('TEST_APP_SECRET', later)
    await writeFile(join(cwd, 'demo.txt'), `${initial} ${later}`)
    const output = await call('read', { path: 'demo.txt' })
    expect(text(output)).toBe('1\t[凭据已隐藏] [凭据已隐藏]')
    vi.spyOn(fsPromises, 'realpath').mockRejectedValueOnce(new Error(`内部失败：${later}`))
    await expect(call('read', { path: 'demo.txt' })).rejects.toThrow('内部失败：[凭据已隐藏]')
    vi.spyOn(fsPromises, 'realpath').mockRejectedValueOnce(Object.assign(new Error(initial), { code: later }))
    await expect(call('read', { path: 'demo.txt' })).rejects.toThrow('工具 read 操作失败（[凭据已隐藏]）。')
  })
})

describe('bash 工具', () => {
  beforeEach(() => {
    tools = codingTools(cwd, { allowShell: true, blockedCommands: ['forbidden-command'] })
  })

  it('执行命令、返回退出码、限制输出', async () => {
    expect(text(await call('bash', { command: 'printf "你好"' }))).toBe('你好')
    const failed = await call('bash', { command: 'printf "错误" >&2; exit 3' })
    expect(failed.isError).toBe(true)
    expect(failed.details).toMatchObject({ exitCode: 3, sandbox: false })
    const output = await call('bash', { command: 'printf "%040000d" 1' })
    expect(Buffer.byteLength(text(output))).toBeLessThanOrEqual(32768)
    expect(output.details).toMatchObject({ truncated: true })
  })

  it('阻止黑名单和非法超时', async () => {
    await expect(call('bash', { command: 'echo forbidden-command' })).rejects.toThrow('禁止命令')
    await expect(call('bash', { command: 'printf x', timeoutMs: 120001 })).rejects.toThrow('参数无效')
  })

  it('命令超时终止进程组', async () => {
    await expect(call('bash', { command: 'while :; do :; done', timeoutMs: 40 })).rejects.toThrow('超时')
  })

  it('执行前和执行中取消命令', async () => {
    const pre = new AbortController()
    pre.abort()
    await expect(call('bash', { command: 'printf x' }, pre.signal)).rejects.toThrow('取消')
    const running = new AbortController()
    const pending = call('bash', { command: 'while :; do :; done' }, running.signal)
    const timer = setTimeout(() => running.abort(), 40)
    try {
      await expect(pending).rejects.toThrow('取消')
    } finally {
      clearTimeout(timer)
    }
  })
})
