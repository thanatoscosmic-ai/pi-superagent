import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/pi/cli.ts', import.meta.url))

describe('pi CLI', () => {
  it('无模型凭据也能显示帮助', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', cli, '--help'], { env: { ...process.env, OPENAI_API_KEY: '' } })
    expect(result.stdout).toContain('pi-superagent run')
    expect(result.stdout).toContain('OPENAI_BASE_URL')
  })
  it('版本命令无需模型配置', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', cli, '--version'])
    expect(result.stdout.trim()).toBe('pi-superagent 0.2.0')
  })
  it('默认 coding 模式缺少凭据时提供明确提示', async () => {
    await expect(exec(process.execPath, ['--import', 'tsx', cli, '-p', '解释项目'],
      { env: { ...process.env, OPENAI_API_KEY: '' } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('OPENAI_API_KEY') })
  })
  it('显式配置禁用本地操作者时不能自动重写授权', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-cli-'))
    const config = join(root, 'settings.json')
    writeFileSync(config, JSON.stringify({ policy: { sources: { local: { allowed: [] } } } }))
    try {
      await expect(exec(process.execPath, ['--import', 'tsx', cli, 'run', '修改文件', '--state', join(root, 'state'), '--config', config],
        { env: { ...process.env, OPENAI_API_KEY: '' } })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('ignore') })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('管理命令通过已认证 API 转发至运行中的服务', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer cli-test-token')
      requests.push(request.url ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无测试端口')
    try {
      await exec(process.execPath, ['--import', 'tsx', cli, 'stop', 'ticket-1', '--port', String(address.port)],
        { env: { ...process.env, PI_SUPERAGENT_TOKEN: 'cli-test-token' } })
      expect(requests).toEqual(['/api/tickets/ticket-1/stop'])
    } finally { await new Promise<void>(done => server.close(() => done())) }
  })
  it('serve 缺少管理令牌时安全拒绝启动', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-cli-'))
    try {
      await expect(exec(process.execPath, ['--import', 'tsx', cli, 'serve', '--state', root],
        { env: { ...process.env, PI_SUPERAGENT_TOKEN: '' } })).rejects.toMatchObject({ code: 1 })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
