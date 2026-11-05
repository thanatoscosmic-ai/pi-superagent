import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { HEADROOM, TRIMMED, contextBudget, estimateMessages, estimateText, trimMessages } from '../src/pi/context.ts'

let at = 0
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: ++at })
const assistant = (text: string): AgentMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'openai', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: ++at,
})
const toolResult = (text: string): AgentMessage => ({
  role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: ++at,
})

describe('上下文预算', () => {
  it('把中文按每字一个 token 估计，而不是按 3.5 字符一个 token', () => {
    expect(estimateText('中'.repeat(100))).toBe(100)
    expect(estimateText('a'.repeat(350))).toBe(100)
    expect(estimateText('中a'.repeat(50))).toBe(50 + Math.ceil(50 / 3.5))
    expect(estimateText('')).toBe(0)
  })

  it('预算为窗口减去留给回答的余量，且不会低于最小值', () => {
    expect(contextBudget(128000)).toBe(128000 - HEADROOM)
    expect(contextBudget(2048)).toBe(1024)
  })

  it('容量足够时原样返回，不做任何改写', () => {
    const messages = [user('开始'), assistant('好的')]
    expect(trimMessages(messages, 128000)).toEqual(messages)
    expect(trimMessages(messages, 0)).toEqual(messages)
  })

  it('超出窗口时丢弃最旧的消息，保留系统提示、首个请求与最新步骤', () => {
    const system: AgentMessage = { role: 'system', content: '系统提示', timestamp: 0 }
    const brief = user(`开始工作：${'要'.repeat(10)}`)
    const old = Array.from({ length: 20 }, (_, index) => assistant(`旧步骤 ${index}：${'字'.repeat(200)}`))
    const newest = user('最新要求')
    const messages = [system, brief, ...old, newest]
    const trimmed = trimMessages(messages, 2048)
    expect(trimmed[0]).toEqual(system)
    expect(JSON.stringify(trimmed)).toContain('开始工作')
    expect(trimmed.at(-1)).toEqual(newest)
    expect(trimmed.some(message => JSON.stringify(message).includes(TRIMMED))).toBe(true)
    expect(estimateMessages(trimmed)).toBeLessThanOrEqual(contextBudget(2048) + HEADROOM)
    expect(trimmed.length).toBeLessThan(messages.length)
  })

  it('不拆开工具调用与它的结果，也不会以工具结果开头', () => {
    const call: AgentMessage = {
      role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }], api: 'openai-completions',
      provider: 'openai', model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: ++at,
    }
    const big = { ...toolResult(`内容 ${'字'.repeat(1500)}`), toolCallId: 'c1' } as AgentMessage
    const messages = [user('开始'), assistant(`第一段${'字'.repeat(1500)}`), call, big, assistant('收尾')]
    const trimmed = trimMessages(messages, 3072)
    const firstRest = trimmed.findIndex(message => JSON.stringify(message).includes(TRIMMED)) + 1
    expect(firstRest).toBeGreaterThan(0)
    expect(trimmed[firstRest]?.role).not.toBe('toolResult')
    for (const [index, message] of trimmed.entries()) {
      if (message.role !== 'toolResult') continue
      const call = trimmed.slice(0, index).reverse().find(item => item.role === 'assistant')
      expect(JSON.stringify(call)).toContain(message.toolCallId)
    }
    expect(JSON.stringify(trimmed)).toContain('内容')
  })
})
