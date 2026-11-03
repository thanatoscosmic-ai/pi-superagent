import { Agent } from '@earendil-works/pi-agent-core'
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, streamSimple } from '@earendil-works/pi-ai/compat'
import { describe, expect, it } from 'vitest'
import { assessCandidate } from '../src/pi/assessment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Candidate } from '../src/core/index.ts'

const candidate: Candidate = {
  evalId: 'eval', strength: 'explicit', policyVersion: 'v1', tickets: [],
  thread: { key: 'local:t', ref: { source: 'local', id: 't' }, createdAt: new Date().toISOString(), subscriptions: [], correlated: [], pending: [], meta: {} },
  triggers: [{ id: 'trigger', source: 'local', threads: [{ source: 'local', id: 't' }], actor: { source: 'local', id: 'operator' },
    human: true, addressed: 'direct', text: '修正错字', at: new Date().toISOString(), meta: {} }],
}

const submission = { decision: 'accept', title: '修正', scope: '指定错字', reason: '用户请求', intent_evidence: '修正错字',
  rule_assessments: [{ rule_id: 'copy', matched: true, reason: '文字修正' }, { rule_id: 'visual', matched: false, reason: '非视觉' }],
  direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: '指定修正' } }

describe('pi 结构化评估', () => {
  it('真实 pi 工具循环提交有效评估', async () => {
    const provider = registerFauxProvider()
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('submit_assessment', submission, { id: 'assessment' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('已提交')),
    ])
    try {
      const result = await assessCandidate(options => new Agent({ initialState: { ...options, model: provider.getModel() }, streamFn: streamSimple }), candidate, SettingsSchema.parse({}))
      expect(result.decision).toBe('accept')
      expect(result.rule_assessments).toHaveLength(2)
    } finally { provider.unregister() }
  })
  it('无结构化结论不能假装通过', async () => {
    const provider = registerFauxProvider()
    provider.setResponses([fauxAssistantMessage(fauxText('看起来可以'))])
    try {
      await expect(assessCandidate(options => new Agent({ initialState: { ...options, model: provider.getModel() }, streamFn: streamSimple }), candidate, SettingsSchema.parse({}))).rejects.toThrow('未提交')
    } finally { provider.unregister() }
  })
})
