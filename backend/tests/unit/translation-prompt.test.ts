import { describe, it, expect } from 'vitest'
import { buildTranslationPrompt } from '../../src/translation/provider'
import type { TranslationContext } from '../../src/translation/provider'

function makeContext(overrides: Partial<TranslationContext> = {}): TranslationContext {
  return {
    glossary: [],
    previousContext: '',
    documentTitle: 'test.md',
    chunkIndex: 0,
    totalChunks: 3,
    hasTable: false,
    ...overrides,
  }
}

describe('buildTranslationPrompt', () => {
  it('includes source and target languages', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext())
    expect(prompt).toContain('from en to es')
  })

  it('includes glossary entries when provided', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext({
      glossary: [
        { source: 'API', target: 'API', type: 'technical' },
        { source: 'Stark Industries', target: 'Stark Industries', type: 'keep_original' },
      ],
    }))
    expect(prompt).toContain('API → API')
    expect(prompt).toContain('Stark Industries → Stark Industries')
  })

  it('omits glossary section when no entries', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext())
    expect(prompt).not.toContain('Glossary')
  })

  it('includes previous context when provided', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext({
      previousContext: 'the end of the last chunk.',
    }))
    expect(prompt).toContain('the end of the last chunk.')
  })

  it('includes chunk position', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext({
      chunkIndex: 2,
      totalChunks: 5,
    }))
    expect(prompt).toContain('chunk 3 of 5')
  })

  it('adds table instruction when hasTable is true', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext({ hasTable: true }))
    expect(prompt).toContain('markdown table')
    expect(prompt).toContain('pipes/dashes')
  })

  it('does not add table instruction when hasTable is false', () => {
    const prompt = buildTranslationPrompt('en', 'es', makeContext({ hasTable: false }))
    expect(prompt).not.toContain('markdown table')
  })
})
