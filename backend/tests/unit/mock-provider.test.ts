import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/translation/mock-provider'
import type { TranslationContext } from '../../src/translation/provider'

function makeContext(overrides: Partial<TranslationContext> = {}): TranslationContext {
  return {
    glossary: [],
    previousContext: '',
    documentTitle: 'test.md',
    chunkIndex: 0,
    totalChunks: 1,
    hasTable: false,
    ...overrides,
  }
}

describe('MockProvider', () => {
  it('returns a predictable translation', async () => {
    const provider = new MockProvider()
    const result = await provider.translate('Hello world', 'en', 'es', makeContext())

    expect(result.translatedText).toBe('[es] Hello world')
    expect(result.model).toBe('mock')
    expect(result.fromCache).toBe(false)
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
    expect(result.costUsd).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs each call', async () => {
    const provider = new MockProvider()
    await provider.translate('First', 'en', 'es', makeContext())
    await provider.translate('Second', 'en', 'fr', makeContext({ chunkIndex: 1 }))

    expect(provider.callLog).toHaveLength(2)
    expect(provider.callLog[0].text).toBe('First')
    expect(provider.callLog[1].targetLang).toBe('fr')
  })
})
