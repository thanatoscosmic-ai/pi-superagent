import { describe, expect, it } from 'vitest'
import { autoDistanceThreshold, autoSimilarityThreshold, cosineSimilarity } from '../src/pi/similarity.ts'

describe('余弦阈值', () => {
  it('计算真实余弦标量而不是向量元组', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
    expect(autoSimilarityThreshold([[1, 0], [0, 1], [-1, 0]])).toBe(0)
    expect(autoDistanceThreshold([[1, 0], [0, 1], [-1, 0]])).toBe(1)
  })
  it('处理零向量和不足样本', () => {
    expect(autoSimilarityThreshold([])).toBeNull()
    expect(autoSimilarityThreshold([[1, 0]])).toBeNull()
    expect(autoSimilarityThreshold([[0, 0], [0, 0]])).toBeNull()
    expect(autoDistanceThreshold([[0, 0], [1, 0]])).toBeNull()
  })
  it('拒绝无效维度并避免大数溢出', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow()
    expect(() => cosineSimilarity([NaN], [1])).toThrow()
    expect(cosineSimilarity([1e300, 0], [1e300, 0])).toBe(1)
  })
})
