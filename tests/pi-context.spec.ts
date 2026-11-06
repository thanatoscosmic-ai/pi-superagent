import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_PREFIX, DEFAULT_COMPACTION, KEEP_RECENT_TOKENS, RESERVE_TOKENS,
  compactIfNeeded, estimateMessages, estimateText, findCut, previousSummary, readSummary, serialize, shouldCompact, summaryMessage,
} from '../src/pi/context.ts'

let at = 0
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: ++at })
const assistant = (text: string): AgentMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'openai', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: ++at,
})
const toolResult = (text: string, id = 'c1'): AgentMessage => ({
  role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: ++at,
})
const summarize = vi.fn(async (_systemPrompt: string, _prompt: string) => '## 目标\n完成架构文档')

describe('上下文估算', () => {
  it('中文按每字一个 token 估算，而不是 pi 的每 3.5 字符一个', () => {
    expect(estimateText('中'.repeat(100))).toBe(100)
    expect(estimateText('a'.repeat(350))).toBe(100)
    expect(estimateText('')).toBe(0)
  })
})

describe('压缩阈值', () => {
  it('与 pi 一致：超过窗口减去 reserveTokens 才压缩，默认 16384 与 20000', () => {
    expect(DEFAULT_COMPACTION).toEqual({ enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS })
    expect(RESERVE_TOKENS).toBe(16384)
    expect(KEEP_RECENT_TOKENS).toBe(20000)
    expect(shouldCompact(1000, 128000)).toBe(false)
    expect(shouldCompact(128000 - RESERVE_TOKENS + 1, 128000)).toBe(true)
    expect(shouldCompact(999999, 0)).toBe(false)
    expect(shouldCompact(999999, 128000, { ...DEFAULT_COMPACTION, enabled: false })).toBe(false)
  })
})

describe('切点', () => {
  it('保留最近约 keepRecentTokens，切在可开始的回合边界，绝不以工具结果开头', () => {
    const messages = [user('开始'), ...Array.from({ length: 10 }, (_, index) => [
      assistant(`第 ${index} 步：${'字'.repeat(3000)}`),
      toolResult(`结果 ${index}：${'字'.repeat(3000)}`),
    ]).flat()]
    const cut = findCut(messages, 20000)
    expect(cut).toBeGreaterThan(0)
    expect(['user', 'assistant']).toContain(messages[cut]?.role)
    expect(estimateMessages(messages.slice(cut))).toBeGreaterThanOrEqual(20000)
    // 切在 assistant 时，它的工具结果紧随其后一起保留。
    for (const [index, message] of messages.slice(cut).entries()) {
      if (message.role !== 'toolResult' || index === 0) continue
      expect(estimateMessages([message])).toBeGreaterThan(0)
    }
  })

  it('短会话没有切点，返回系统消息之后的位置', () => {
    const system: AgentMessage = { role: 'system', content: '提示', timestamp: 0 }
    expect(findCut([system, user('问'), assistant('答')], 20000)).toBe(1)
  })
})

describe('摘要', () => {
  it('序列化省略 thinking 并截断工具结果', () => {
    const thinking: AgentMessage = {
      role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '结论' }],
      api: 'openai-completions', provider: 'openai', model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: ++at,
    }
    const text = serialize([user('读取文件'), thinking, toolResult('内'.repeat(5000))])
    expect(text).toContain('[User]: 读取文件')
    expect(text).toContain('[Assistant]: 结论')
    expect(text).not.toContain('内部推理')
    expect(text).toContain('个字符已省略')
  })

  it('拒绝被长度上限截断或失败的摘要', () => {
    expect(() => readSummary({ content: [], stopReason: 'length' })).toThrow('未采用不完整的摘要')
    expect(() => readSummary({ content: [], stopReason: 'error', errorMessage: '离线' })).toThrow('离线')
    expect(readSummary({ content: [{ type: 'text', text: ' 摘要 ' }], stopReason: 'stop' })).toBe('摘要')
  })

  it('摘要写成可再次合并的检查点消息', () => {
    const message = summaryMessage('## 目标\n写完')
    expect(message.role).toBe('user')
    expect(String(message.content)).toContain(COMPACTION_PREFIX)
    expect(previousSummary([message, user('继续')])).toBe('## 目标\n写完')
    expect(previousSummary([user('第一次请求')])).toBeUndefined()
  })
})

describe('按 pi 的方式压缩', () => {
  it('未达阈值时不做任何调用', async () => {
    const call = vi.fn(async () => '摘要')
    expect(await compactIfNeeded([user('短'), assistant('答')], 128000, call)).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })

  it('超过阈值时摘要旧消息，保留系统提示与最近一段，第二次压缩合并上一份摘要', async () => {
    const system: AgentMessage = { role: 'system', content: '系统提示', timestamp: 0 }
    const old = Array.from({ length: 20 }, (_, index) => [user(`请求 ${index}：${'字'.repeat(6000)}`), assistant(`回答 ${index}`)]).flat()
    const first = await compactIfNeeded([system, ...old], 128000, summarize)
    expect(first).toBeDefined()
    expect(summarize).toHaveBeenCalledOnce()
    const [systemPrompt] = summarize.mock.calls[0]!
    expect(systemPrompt).toContain('summarization assistant')
    expect(first!.messages[0]).toEqual(system)
    expect(String(first!.messages[1]!.content)).toContain(COMPACTION_PREFIX)
    expect(first!.tokensAfter).toBeLessThan(first!.tokensBefore)

    const second = await compactIfNeeded([...first!.messages, ...Array.from({ length: 20 }, (_, index) => user(`后续 ${index}：${'字'.repeat(6000)}`))], 128000, summarize)
    const prompt = summarize.mock.calls[1]![1]
    expect(prompt).toContain('<previous-summary>')
    expect(prompt).toContain('Update the existing structured summary')
    expect(second!.messages.filter(message => String(message.content).includes(COMPACTION_PREFIX))).toHaveLength(1)
  })

  it('没有可压缩的历史时返回 undefined，而不是写空摘要', async () => {
    const call = vi.fn(async () => '摘要')
    const messages = [user(`唯一请求：${'字'.repeat(100000)}`)]
    expect(await compactIfNeeded(messages, 128000, call)).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })
})
