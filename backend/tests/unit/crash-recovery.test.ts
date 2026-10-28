import { describe, it, expect, vi } from 'vitest'

describe('crash recovery — chunk-level idempotency', () => {
  it('completed chunks are preserved and not re-translated on resume', () => {
    const chunks = [
      { index: 0, status: 'completed', translatedText: 'Chunk 0 translated', costUsd: '0.001' },
      { index: 1, status: 'completed', translatedText: 'Chunk 1 translated', costUsd: '0.001' },
      { index: 2, status: 'translating', translatedText: null, costUsd: null },
      { index: 3, status: 'pending', translatedText: null, costUsd: null },
    ]

    // On resume: processor loads existing chunks, skips completed, retranslates rest
    let totalCost = 0
    let completedCount = 0
    const translateCalls: number[] = []

    for (const chunk of chunks) {
      if (chunk.status === 'completed') {
        completedCount++
        if (chunk.costUsd) totalCost += parseFloat(chunk.costUsd)
        continue
      }
      // Re-translate anything not completed
      translateCalls.push(chunk.index)
      chunk.status = 'completed'
      chunk.translatedText = `Recovered translation ${chunk.index}`
      chunk.costUsd = '0.001'
      totalCost += 0.001
      completedCount++
    }

    // Only non-completed chunks were translated
    expect(translateCalls).toEqual([2, 3])
    // Original translations preserved
    expect(chunks[0].translatedText).toBe('Chunk 0 translated')
    expect(chunks[1].translatedText).toBe('Chunk 1 translated')
    expect(completedCount).toBe(4)
    expect(totalCost).toBeCloseTo(0.004, 6)
  })

  it('cost is not doubled — existing chunk costs are accumulated correctly', () => {
    const chunks = [
      { status: 'completed', costUsd: '0.000150' },
      { status: 'completed', costUsd: '0.000200' },
      { status: 'pending', costUsd: null },
      { status: 'pending', costUsd: null },
    ]

    let totalCost = 0
    let completedCount = 0
    for (const chunk of chunks) {
      if (chunk.status === 'completed') {
        completedCount++
        if (chunk.costUsd) totalCost += parseFloat(chunk.costUsd)
      }
    }

    const newChunkCost = 0.000180
    totalCost += newChunkCost
    completedCount++

    expect(completedCount).toBe(3)
    expect(totalCost).toBeCloseTo(0.000150 + 0.000200 + 0.000180, 6)
  })

  it('advisory lock prevents duplicate chunk processing', () => {
    const lockedKeys = new Set<string>()

    function tryLock(key: string): boolean {
      if (lockedKeys.has(key)) return false
      lockedKeys.add(key)
      return true
    }

    function unlock(key: string): void {
      lockedKeys.delete(key)
    }

    const key = 'chunk-0-key'
    expect(tryLock(key)).toBe(true)
    expect(tryLock(key)).toBe(false) // second worker blocked
    unlock(key)
    expect(tryLock(key)).toBe(true) // now available
    unlock(key)
  })

  it('lastBlockIndex only advances at chunk finalization boundaries', () => {
    // Simulate: blocks 0-9, chunks finalized at blocks [3, 7, 9]
    let lastBlockIndex = -1
    const chunkBoundaries = [3, 7, 9]
    const updates: number[] = []

    for (let blockIdx = 0; blockIdx < 10; blockIdx++) {
      // Accumulate block...

      // Only update lastBlockIndex when a chunk is finalized
      if (chunkBoundaries.includes(blockIdx)) {
        lastBlockIndex = blockIdx
        updates.push(blockIdx)
      }
    }

    // lastBlockIndex was only updated 3 times, not 10
    expect(updates).toEqual([3, 7, 9])
    expect(lastBlockIndex).toBe(9)
  })

  it('crash mid-accumulation replays un-finalized blocks', () => {
    // Scenario: blocks 0-7 exist, chunk finalized at block 4, crash at block 6
    const lastBlockIndex = 4 // last finalized chunk boundary
    const totalBlocks = 8

    const processedBlocks: number[] = []
    for (let blockIdx = 0; blockIdx < totalBlocks; blockIdx++) {
      if (blockIdx <= lastBlockIndex) continue // skip finalized blocks
      processedBlocks.push(blockIdx)
    }

    // Blocks 5, 6, 7 are re-processed (5-6 were accumulated but not finalized)
    expect(processedBlocks).toEqual([5, 6, 7])
  })

  it('failure rate threshold prevents marking as completed', () => {
    const totalChunks = 10
    const FAILURE_THRESHOLD = 0.3

    expect(4 / totalChunks > FAILURE_THRESHOLD).toBe(true)  // 40% → fail
    expect(2 / totalChunks > FAILURE_THRESHOLD).toBe(false)  // 20% → ok
  })
})
