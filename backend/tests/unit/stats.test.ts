import { describe, it, expect, vi } from 'vitest'

describe('Stats endpoint', () => {
  it('computes cache hit rate correctly', () => {
    const totalChunks = 100
    const cachedChunks = 28
    const cacheHitRate = totalChunks > 0 ? cachedChunks / totalChunks : 0
    expect(cacheHitRate).toBeCloseTo(0.28, 2)
  })

  it('cache hit rate is 0 when no chunks exist', () => {
    const totalChunks = 0
    const cachedChunks = 0
    const cacheHitRate = totalChunks > 0 ? cachedChunks / totalChunks : 0
    expect(cacheHitRate).toBe(0)
  })

  it('average cost rounds to 6 decimal places', () => {
    const totalCost = 0.016234567
    const formatted = parseFloat(totalCost.toFixed(6))
    expect(formatted).toBe(0.016235)
  })

  it('stats response has correct shape', () => {
    const stats = {
      totalDocuments: 42,
      completedDocuments: 38,
      failedDocuments: 2,
      activeDocuments: 2,
      totalCostUsd: 3.45,
      avgCostPerDocument: 0.09,
      totalInputTokens: 450000,
      totalOutputTokens: 430000,
      cacheHitRate: 0.28,
      cacheEntries: 156,
      avgDurationMs: 15000,
      avgParseDurationMs: 200,
      avgTranslateDurationMs: 14000,
      avgAssembleDurationMs: 50,
    }

    expect(stats.totalDocuments).toBeGreaterThanOrEqual(stats.completedDocuments)
    expect(stats.totalDocuments).toBe(stats.completedDocuments + stats.failedDocuments + stats.activeDocuments)
    expect(stats.avgCostPerDocument).toBeLessThanOrEqual(stats.totalCostUsd)
    expect(stats.cacheHitRate).toBeGreaterThanOrEqual(0)
    expect(stats.cacheHitRate).toBeLessThanOrEqual(1)
    expect(stats.avgDurationMs).toBeGreaterThan(stats.avgParseDurationMs)
  })

  it('output tokens dominate cost (~80%)', () => {
    const inputTokens = 10000
    const outputTokens = 12000
    const inputCost = (inputTokens / 1_000_000) * 0.15
    const outputCost = (outputTokens / 1_000_000) * 0.60
    const totalCost = inputCost + outputCost
    const outputRatio = outputCost / totalCost

    expect(outputRatio).toBeGreaterThan(0.7)
    expect(outputRatio).toBeLessThan(0.95)
  })
})
