import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { MockProvider } from '../../src/translation/mock-provider'
import { textToBlocks } from '../../src/parsers/index'

/**
 * Back-Translation Quality Score (BT-Score) Measurement
 *
 * Measures translation quality by:
 * 1. Translating original text (en → target)
 * 2. Translating it back (target → en)
 * 3. Measuring word overlap between original and back-translated text
 *
 * A BT-Score of 1.0 = perfect preservation, 0.0 = no overlap.
 * Typical good translations: 0.6–0.9
 *
 * NOTE: With MockProvider, BT-Score is high because mock just prepends "[lang]".
 * With a real OpenAI provider, BT-Score would reflect actual translation quality.
 * The quality/ tests are the only ones that could optionally use real API calls.
 */

function wordOverlapRatio(original: string, backTranslated: string): number {
  const origWords = new Set(original.toLowerCase().split(/\s+/).filter((w) => w.length > 0))
  const backWords = new Set(backTranslated.toLowerCase().split(/\s+/).filter((w) => w.length > 0))
  if (origWords.size === 0) return 0
  const overlap = [...origWords].filter((w) => backWords.has(w)).length
  return overlap / origWords.size
}

function loadTestParagraphs(filePath: string, maxParagraphs: number): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const blocks = textToBlocks(content)
  return blocks
    .filter((b) => b.translatable && b.text.trim().length > 20)
    .map((b) => b.text)
    .slice(0, maxParagraphs)
}

describe('Back-Translation Quality (BT-Score)', () => {
  it('measure BT-Score for English → Spanish (MockProvider)', async () => {
    const fixturesDir = path.join(__dirname, '..', 'fixtures')
    const paragraphs = loadTestParagraphs(path.join(fixturesDir, 'sample.md'), 10)

    expect(paragraphs.length).toBeGreaterThan(0)

    const provider = new MockProvider()
    let totalScore = 0

    for (const para of paragraphs) {
      const forward = await provider.translate(para, 'en', 'es', {
        glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
      })

      const back = await provider.translate(forward.translatedText, 'es', 'en', {
        glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
      })

      const score = wordOverlapRatio(para, back.translatedText)
      totalScore += score
    }

    const btScore = totalScore / paragraphs.length
    console.log(`BT-Score (EN→ES, MockProvider): ${btScore.toFixed(3)}`)
    console.log(`Paragraphs tested: ${paragraphs.length}`)

    // Write results for DECISIONS.md
    const resultsPath = path.join(__dirname, '..', '..', 'bt-score-results.json')
    fs.writeFileSync(resultsPath, JSON.stringify({
      btScore,
      language: 'en→es',
      paragraphs: paragraphs.length,
      provider: 'MockProvider',
      note: 'MockProvider prepends [lang] prefix, so overlap is high. Real OpenAI would produce a real BT-Score.',
    }, null, 2))

    expect(btScore).toBeGreaterThan(0.5)
  })

  it('measure BT-Score for English → German (MockProvider)', async () => {
    const fixturesDir = path.join(__dirname, '..', 'fixtures')
    const paragraphs = loadTestParagraphs(path.join(fixturesDir, 'sample.md'), 10)

    const provider = new MockProvider()
    let totalScore = 0

    for (const para of paragraphs) {
      const forward = await provider.translate(para, 'en', 'de', {
        glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
      })

      const back = await provider.translate(forward.translatedText, 'de', 'en', {
        glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
      })

      const score = wordOverlapRatio(para, back.translatedText)
      totalScore += score
    }

    const btScore = totalScore / paragraphs.length
    console.log(`BT-Score (EN→DE, MockProvider): ${btScore.toFixed(3)}`)
    expect(btScore).toBeGreaterThan(0.5)
  })

  it('BT-Score is 0 for completely different texts', () => {
    const score = wordOverlapRatio(
      'The cat sat on the mat',
      'Un perro camina por la calle',
    )
    // These are completely different words, score should be very low
    expect(score).toBeLessThan(0.5)
  })

  it('BT-Score is 1.0 for identical texts', () => {
    const text = 'The system uses PostgreSQL for data storage'
    const score = wordOverlapRatio(text, text)
    expect(score).toBe(1.0)
  })

  it('BT-Score handles empty text', () => {
    expect(wordOverlapRatio('', '')).toBe(0)
    expect(wordOverlapRatio('hello', '')).toBe(0)
  })

  it('wordOverlapRatio is case-insensitive', () => {
    const score = wordOverlapRatio(
      'Hello World Test',
      'hello world test',
    )
    expect(score).toBe(1.0)
  })

  it('BT-Score is partial for overlapping texts', () => {
    const score = wordOverlapRatio(
      'The quick brown fox jumps over the lazy dog',
      'The quick brown cat sits on the lazy mat',
    )
    // Some words overlap (the, quick, brown, lazy), some don't
    expect(score).toBeGreaterThan(0.3)
    expect(score).toBeLessThan(1.0)
  })
})
