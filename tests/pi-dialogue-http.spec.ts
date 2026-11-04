import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalController } from '../src/pi/terminal-controller.ts'
import type { TerminalEvent } from '../src/pi/terminal-types.ts'

interface RequestBody {
  tools?: { function: { name: string } }[]
  messages: { role: string; content: unknown; tool_calls?: { function: { name: string } }[] }[]
}

const contentText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''

it('实际 HTTP 模型适配器完成问候、咨询、澄清与授权编码全链路', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-dialogue-http-')))
  const cwd = join(root, 'repo')
  execFileSync('git', ['init', '-q', cwd])
  writeFileSync(join(cwd, 'message.txt'), 'old')
  execFileSync('git', ['-C', cwd, 'add', '.'])
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'])
  const requests: RequestBody[] = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const part of request) raw += part.toString()
      const body = JSON.parse(raw) as RequestBody
      requests.push(body)
      const tools = body.tools?.map(tool => tool.function.name) ?? []
      const last = body.messages.at(-1)
      let text = '已提交评估'
      let call: { name: string; arguments: Record<string, unknown> } | undefined
      if (tools.includes('submit_assessment') && last?.role !== 'tool') {
        const input = JSON.parse(contentText(body.messages.findLast(message => message.role === 'user')?.content)) as {
          messages: { text: string }[]; rules: { id: string }[];
        }
        const task = input.messages.at(-1)?.text === '将 message.txt 改为 fixed'
        call = { name: 'submit_assessment', arguments: {
          decision: task ? 'accept' : 'ignore', title: task ? '修正文本' : '普通对话', scope: task ? '将 message.txt 改为 fixed' : '不执行',
          reason: task ? '目标明确的用户请求' : '不是目标明确的实施请求',
          rule_assessments: input.rules.map(rule => ({ rule_id: rule.id, matched: task, reason: task ? '用户指定目标' : '仅对话或目标未确定' })),
          direction: { implementation_requested: task, target_basis: task ? 'specified' : 'undetermined', requires_design_decision: false, evidence: task ? '指定 fixed' : '未授权实施' },
          intent_evidence: task ? '将 message.txt 改为 fixed' : null,
        } }
      } else if (!tools.length) {
        const user = contentText(body.messages.findLast(message => message.role === 'user')?.content)
        text = user === 'hi' ? '你好！有什么可以帮助你？' : user === 'nihao' ? '你好，我们可以继续交流。'
          : user === '你能做什么？' ? '我可以解释问题；明确的编码任务会通过授权流程执行。' : '目标尚未确定，未执行修改。你希望文件改成什么内容？'
      } else if (tools.includes('orchestrator_report')) {
        const prior = body.messages.flatMap(message => message.tool_calls ?? []).at(-1)?.function.name
        call = prior === 'write' ? { name: 'orchestrator_report', arguments: { state: 'ready', summary: '已验证文本内容为 fixed' } }
          : { name: 'write', arguments: { path: 'message.txt', content: 'fixed' } }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
        : { role: 'assistant', content: text }
      const chunk = { id: `response-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] }
      response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch {
      response.writeHead(500); response.end('测试服务解析失败')
    }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试端口无效')
  vi.stubEnv('OPENAI_API_KEY', 'offline-http-key')
  vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`)
  vi.stubEnv('OPENAI_MODEL', 'test-model')
  let controller: Awaited<ReturnType<typeof createTerminalController>> | undefined
  const events: TerminalEvent[] = []
  const responses = () => events.flatMap(event => event.type === 'agent' && event.ticketId === 'dialogue'
    && event.value.type === 'message_end' && event.value.message.role === 'assistant'
    ? [contentText(event.value.message.content)] : [])
  try {
    controller = await createTerminalController({ cwd, stateDir: join(root, 'state') })
    controller.subscribe(event => events.push(event))
    for (const [index, prompt] of ['hi', 'nihao', '你能做什么？', '帮我把项目改好'].entries()) {
      await controller.submit(prompt)
      await vi.waitFor(() => expect(responses()).toHaveLength(index + 1), { timeout: 10_000 })
      await vi.waitFor(() => expect(controller?.snapshot()).toMatchObject({ evaluating: 0, queued: 0, running: 0 }), { timeout: 10_000 })
    }
    expect(responses()[0]).toContain('你好')
    expect(responses()[1]).toContain('继续交流')
    expect(responses()[2]).toContain('解释问题')
    expect(responses()[3]).toContain('你希望文件改成什么内容')
    expect(controller.snapshot().tickets).toHaveLength(0)
    expect(readFileSync(join(cwd, 'message.txt'), 'utf8')).toBe('old')
    const dialogueRequests = requests.filter(body => !(body.tools?.length))
    expect(dialogueRequests).toHaveLength(4)
    expect(dialogueRequests[1]?.messages.some(message => contentText(message.content).includes('hi'))).toBe(true)
    await controller.submit('将 message.txt 改为 fixed')
    await vi.waitFor(() => expect(controller?.snapshot().tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 10_000 })
    const ticket = controller.snapshot().tickets[0]!
    expect(ticket.mandate.scope).toBe('将 message.txt 改为 fixed')
    expect(readFileSync(join(ticket.execution!.directory, 'message.txt'), 'utf8')).toBe('fixed')
    expect(readFileSync(join(cwd, 'message.txt'), 'utf8')).toBe('old')
    expect(events.some(event => event.type === 'reply' && event.text.includes('已验证'))).toBe(true)
  } finally {
    await controller?.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
