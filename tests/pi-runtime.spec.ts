import { Agent } from '@earendil-works/pi-agent-core'
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, streamSimple } from '@earendil-works/pi-ai/compat'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PiRuntime } from '../src/pi/runtime.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Assessment } from '../src/policy.ts'

const assessment: Assessment = {
  decision: 'accept', title: '修正文本', scope: '将 message.txt 内容改成 fixed', reason: '明确请求',
  direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: '改成 fixed' },
  rule_assessments: [{ rule_id: 'copy', matched: true, reason: '指定文本修正' }, { rule_id: 'visual', matched: false, reason: '非视觉修改' }],
  intent_evidence: '用户明确要求修改', acknowledgement: '已接收',
}

function setup(assess = async () => assessment) {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', repo])
  writeFileSync(join(repo, 'message.txt'), 'old')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'])
  const provider = registerFauxProvider()
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('write', { path: 'message.txt', content: 'fixed' }, { id: 'write-1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('orchestrator_report', { state: 'ready', summary: '文本已修正' }, { id: 'report-1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxText('完成')),
  ])
  const runtime = new PiRuntime({ stateDir: join(root, 'state'), repositoryDirectory: repo, assess,
    agentFactory: options => new Agent({ initialState: { ...options, model: provider.getModel(), thinkingLevel: 'off' }, streamFn: streamSimple }) })
  runtime.configure(SettingsSchema.parse({ policy: { sources: { local: { allowed: [{ id: 'operator' }] } } } }))
  const sent: string[] = []
  runtime.register({ id: 'local', send: async message => { sent.push(message.text) } })
  return { root, repo, runtime, sent, provider }
}

async function cleanup(h: ReturnType<typeof setup>) {
  await h.runtime.close(); h.provider.unregister(); rmSync(h.root, { recursive: true, force: true })
}

describe('独立 pi 端到端运行', () => {
  it('授权、worktree、真实工具调用、报告及回复形成闭环', async () => {
    const h = setup()
    try {
      h.runtime.start()
      h.runtime.submit('把 message.txt 的内容改成 fixed')
      await h.runtime.idle()
      const ticket = h.runtime.store.tickets.list()[0]!
      expect(ticket.mandate.strength).toBe('explicit')
      expect(ticket.ended?.outcome).toBe('completed')
      expect(readFileSync(join(ticket.execution!.directory, 'message.txt'), 'utf8')).toBe('fixed')
      expect(readFileSync(join(h.repo, 'message.txt'), 'utf8')).toBe('old')
      expect(h.sent).toContain('已接收')
    } finally { await cleanup(h) }
  })
  it('不允许的操作者不能开工单', async () => {
    const h = setup()
    try {
      h.runtime.start(); h.runtime.submit('修改文件', 'guest'); await h.runtime.idle()
      expect(h.runtime.store.tickets.list()).toHaveLength(0)
    } finally { await cleanup(h) }
  })
  it('单次运行等待退避中的回复再返回', async () => {
    const h = setup()
    try {
      let attempts = 0
      h.runtime.register({ id: 'retry-channel', send: async () => { if (++attempts === 1) throw new Error('暂时不可用') } })
      h.runtime.store.atomic(() => {
        h.runtime.store.receipts.add({ id: 'retry-reply', channel: { source: 'retry-channel', thread: 't', address: {} }, text: '结果', kind: 'reply' })
        h.runtime.effects.enqueue('reply', 'retry-reply', {})
      })
      h.runtime.start(); await h.runtime.idle(10_000)
      expect(attempts).toBe(2)
      expect(h.runtime.store.replyStatus('retry-reply')).toBe('sent')
    } finally { await cleanup(h) }
  })
  it('不支持的宿主配置在保存前明确拒绝', async () => {
    const h = setup()
    try {
      expect(() => h.runtime.configure({ executor: { prepare: 'npm install' } })).toThrow('executor.prepare')
      expect(() => h.runtime.configure({ executor: { directory: '/tmp/elsewhere' } })).toThrow('执行目录')
      expect(h.runtime.store.settings().executor.prepare).toBe('')
    } finally { await cleanup(h) }
  })
  it('状态目录锁拒绝第二个运行实例', async () => {
    const h = setup()
    try {
      expect(() => new PiRuntime({ stateDir: join(h.root, 'state'), repositoryDirectory: h.repo })).toThrow()
    } finally { await cleanup(h) }
  })
  it('PR 关闭后按领域 follows 结束并且发出关闭通知', async () => {
    const h = setup()
    try {
      h.provider.setResponses([
        fauxAssistantMessage([fauxToolCall('orchestrator_report', { state: 'waiting', summary: '等待 PR' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('等待'),
      ])
      h.runtime.start(); h.runtime.submit('修正文本'); await h.runtime.idle()
      const ticket = h.runtime.store.tickets.list()[0]!
      h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
      h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'PR 已就绪' })
      expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
      h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'closed', new Date().toISOString())
      await h.runtime.effects.idle()
      expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('closed')
      expect(h.sent.some(text => text.includes('关闭（未合并）'))).toBe(true)
    } finally { await cleanup(h) }
  })
  it('暂停期间保留输入，恢复后才执行', async () => {
    const h = setup()
    try {
      await h.runtime.pause(true); h.runtime.start(); h.runtime.submit('修正文本')
      h.runtime.engine.evaluateDue(); await h.runtime.effects.idle()
      expect(h.runtime.store.tickets.list()).toHaveLength(0)
      expect(h.runtime.store.threads.active()).toHaveLength(1)
      await h.runtime.pause(false); await h.runtime.idle()
      expect(h.runtime.store.tickets.list()[0]?.ended?.outcome).toBe('completed')
    } finally { await cleanup(h) }
  })
  it('停用 Source 后过滤其请求', async () => {
    const h = setup()
    try {
      h.runtime.configure({ ...h.runtime.store.settings(), sources: { local: { enabled: false } } })
      h.runtime.start(); const id = h.runtime.submit('修正文本'); await h.runtime.idle()
      expect(h.runtime.store.triggers.disposition(id)?.filtered).toBeDefined()
      expect(h.runtime.store.tickets.list()).toHaveLength(0)
    } finally { await cleanup(h) }
  })
  it('主动 observe 不开工单，auto 才可接受 inferred', async () => {
    for (const mode of ['observe', 'auto'] as const) {
      const h = setup()
      try {
        h.runtime.configure({ ...h.runtime.store.settings(), eval: { mode }, policy: { ...h.runtime.store.settings().policy,
          sources: { local: { allowed: [{ id: 'operator' }], admission: { default: { listedUnaddressed: 'inferred' } } } } } })
        h.runtime.start()
        h.runtime.receive({ id: 'proactive', source: 'local', threads: [{ source: 'local', id: 't' }], actor: { source: 'local', id: 'operator' },
          human: true, at: new Date().toISOString(), text: '修正文本', meta: {}, channel: { source: 'local', thread: 't', address: {} } })
        await h.runtime.idle()
        expect(h.runtime.store.tickets.list()).toHaveLength(mode === 'auto' ? 1 : 0)
      } finally { await cleanup(h) }
    }
  })
  it('评估失败记录 unavailable 且不开工单', async () => {
    const h = setup(async () => { throw new Error('模型不可用') })
    try {
      h.runtime.start(); const id = h.runtime.submit('修改文件'); await h.runtime.idle()
      const disposition = h.runtime.store.triggers.disposition(id)!
      expect(h.runtime.store.decisions.get(disposition.decisionId!)?.kind).toBe('unavailable')
      expect(h.runtime.store.tickets.list()).toHaveLength(0)
    } finally { await cleanup(h) }
  })
})
