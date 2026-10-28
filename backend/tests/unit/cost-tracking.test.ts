import { describe, it, expect } from 'vitest'
import { calculateCost } from '../../src/translation/provider'

describe('calculateCost', () => {
  it('calculates gpt-4o-mini cost correctly', () => {
    // 1000 input tokens, 500 output tokens
    // input: 1000/1M * 0.15 = 0.00015
    // output: 500/1M * 0.60 = 0.0003
    // total: 0.00045
    const cost = calculateCost('gpt-4o-mini', 1000, 500)
    expect(cost).toBeCloseTo(0.00045, 6)
  })

  it('calculates gpt-4o cost correctly', () => {
    // 1000 input tokens, 500 output tokens
    // input: 1000/1M * 2.50 = 0.0025
    // output: 500/1M * 10.00 = 0.005
    // total: 0.0075
    const cost = calculateCost('gpt-4o', 1000, 500)
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('returns zero for zero tokens', () => {
    const cost = calculateCost('gpt-4o-mini', 0, 0)
    expect(cost).toBe(0)
  })

  it('falls back to gpt-4o-mini pricing for unknown models', () => {
    const cost = calculateCost('unknown-model', 1000, 500)
    expect(cost).toBeCloseTo(0.00045, 6)
  })

  it('accumulates costs correctly across chunks', () => {
    const chunk1 = calculateCost('gpt-4o-mini', 500, 600)
    const chunk2 = calculateCost('gpt-4o-mini', 800, 900)
    const chunk3 = calculateCost('gpt-4o-mini', 300, 400)

    const total = chunk1 + chunk2 + chunk3
    const expected = calculateCost('gpt-4o-mini', 500 + 800 + 300, 600 + 900 + 400)
    expect(total).toBeCloseTo(expected, 10)
  })
})
