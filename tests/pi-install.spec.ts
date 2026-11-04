import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

it('源码副本本地安装后能读取配置并完成 coding', async () => {
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
    await exec('tar', ['-xzf', join(temporary, filename), '-C', temporary])
    const checkout = join(temporary, 'package')
    const installEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_allow_scripts$/i.test(name)))
    await exec('npm', ['install', '--ignore-scripts', '--omit=dev'], { cwd: checkout, env: installEnvironment })
    const binary = join(checkout, 'scripts/pi-superagent.mjs')
    expect((await exec(process.execPath, [binary, '--version'])).stdout.trim()).toBe('pi-superagent 0.2.0')
    expect((await exec(process.execPath, [binary, '--help'])).stdout).toContain('交互式 coding CLI')
    writeFileSync(join(checkout, '.env'), `OPENAI_API_KEY=offline-install-key\nOPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1\nOPENAI_MODEL=test\n`)
    const environment = { ...process.env }
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']) delete environment[name]
    const result = await exec('npm', ['start', '--', '-p', '创建 result.txt', '--cwd', temporary, '--session', join(temporary, 'session.json')],
      { cwd: checkout, env: environment })
    expect(result.stdout).toContain('安装运行验证成功')
    expect(readFileSync(join(temporary, 'result.txt'), 'utf8')).toBe('installed coding works')
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    rmSync(temporary, { recursive: true, force: true })
  }
}, 180_000)
