import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

it('发布包能全局安装且仅凭运行依赖完成当前目录 coding', async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'pi-install-')))
  let turn = 0
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const data = JSON.parse(body) as { tools: { function: { name: string } }[] }
    expect(data.tools.some(tool => tool.function.name === 'write')).toBe(true)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = ++turn === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'installed coding works' }) } }] }
      : { role: 'assistant', content: '安装运行验证成功' }
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: null }] }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试端口无效')
  try {
    await exec('npm', ['run', 'build'], { cwd: root })
    const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root })
    const metadata = JSON.parse(packed.stdout) as { filename: string }[] | Record<string, { filename: string }>
    const filename = Object.values(metadata)[0]!.filename
    const prefix = join(temporary, 'global')
    await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--legacy-peer-deps=false', join(temporary, filename)], { cwd: temporary })
    const binary = join(prefix, 'bin', 'pi-superagent')
    expect((await exec(binary, ['--version'])).stdout.trim()).toBe('pi-superagent 0.2.0')
    expect((await exec(binary, ['--help'])).stdout).toContain('交互式 coding CLI')
    const dependencies = await exec('npm', ['list', '--global', '--prefix', prefix, '--all', '--json'], { cwd: temporary })
    expect(dependencies.stdout).not.toContain('"@deepseek-ai/')
    const result = await exec(binary, ['-p', '创建 result.txt', '--cwd', temporary, '--session', join(temporary, 'session.json')],
      { env: { ...process.env, OPENAI_API_KEY: 'offline-install-key', OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OPENAI_MODEL: 'test' } })
    expect(result.stdout).toContain('安装运行验证成功')
    expect(readFileSync(join(temporary, 'result.txt'), 'utf8')).toBe('installed coding works')
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    rmSync(temporary, { recursive: true, force: true })
  }
}, 180_000)
