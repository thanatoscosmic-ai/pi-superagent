export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (!a.length || a.length !== b.length || [...a, ...b].some(value => !Number.isFinite(value))) throw new Error('向量维度必须一致且元素有限')
  const scaleA = Math.max(...a.map(Math.abs)), scaleB = Math.max(...b.map(Math.abs))
  if (!scaleA || !scaleB) return null
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! / scaleA, y = b[i]! / scaleB
    dot += x * y; normA += x * x; normB += y * y
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB)))
}

export function autoSimilarityThreshold(vectors: readonly (readonly number[])[]): number | null {
  if (vectors.length < 2) return null
  const sample = vectors.slice(0, 50), similarities: number[] = []
  for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
    const value = cosineSimilarity(sample[i]!, sample[j]!)
    if (value !== null) similarities.push(value)
  }
  similarities.sort((a, b) => b - a)
  return similarities[Math.floor(similarities.length / 4)] ?? null
}

export function autoDistanceThreshold(vectors: readonly (readonly number[])[]): number | null {
  const similarity = autoSimilarityThreshold(vectors)
  return similarity === null ? null : 1 - similarity
}
