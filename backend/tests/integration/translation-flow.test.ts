import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { MockProvider } from '../../src/translation/mock-provider'
import { textToBlocks } from '../../src/parsers/index'
import { SemanticChunkAgentService } from '../../src/agents/semantic-chunk-agent'
import { estimateTokens } from '../../src/parsers/index'
import { buildTranslationPrompt, calculateCost } from '../../src/translation/provider'

const FIXTURES = path.join(__dirname, '..', 'fixtures')

/** Simulate the streaming chunker loop */
async function streamChunkBlocks(blocks: import('../../src/parsers/index').ContentBlock[]) {
  const agent = new SemanticChunkAgentService()
  const chunks: Array<{ text: string; translatable: boolean; hasTable: boolean }> = []
  let accText = ''
  let accTokens = 0
  let hasTable = false

  for (const b of blocks) {
    if (!b.translatable) {
      if (accText) {
        chunks.push({ text: accText, translatable: true, hasTable })
        accText = ''; accTokens = 0; hasTable = false
      }
      chunks.push({ text: b.text, translatable: false, hasTable: false })
      continue
    }
    if (accText) {
      const d = await agent.shouldSplitBefore(accText, b, accTokens)
      if (d.isComplete) {
        chunks.push({ text: accText, translatable: true, hasTable })
        accText = ''; accTokens = 0; hasTable = false
      }
    }
    accText += (accText ? '\n\n' : '') + b.text
    accTokens += estimateTokens(b.text)
    if (b.type === 'table') hasTable = true
  }
  if (accText) chunks.push({ text: accText, translatable: true, hasTable })
  return chunks
}

describe('Translation flow — end-to-end with MockProvider', () => {
  let provider: MockProvider

  beforeEach(() => {
    provider = new MockProvider()
  })

  it('translates all translatable chunks of a markdown document', async () => {
    const content = await fs.readFile(path.join(FIXTURES, 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)
    const chunks = await streamChunkBlocks(blocks)
    const translatableChunks = chunks.filter((c) => c.translatable)

    expect(translatableChunks.length).toBeGreaterThan(0)

    let totalCost = 0
    for (let i = 0; i < translatableChunks.length; i++) {
      const chunk = translatableChunks[i]
      const result = await provider.translate(chunk.text, 'en', 'es', {
        glossary: [],
        previousContext: '',
        documentTitle: 'sample.md',
        chunkIndex: i,
        totalChunks: translatableChunks.length,
        hasTable: chunk.hasTable,
      })
      totalCost += result.costUsd
      expect(result.translatedText).toContain('[es]')
      expect(result.inputTokens).toBeGreaterThan(0)
    }

    expect(totalCost).toBeGreaterThan(0)
    expect(provider.callLog.length).toBe(translatableChunks.length)
  })

  it('code blocks are not sent to translation provider', async () => {
    const content = await fs.readFile(path.join(FIXTURES, 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)
    const chunks = await streamChunkBlocks(blocks)

    const codeChunks = chunks.filter((c) => !c.translatable)
    expect(codeChunks.length).toBeGreaterThan(0)
    expect(codeChunks[0].text).toContain('console.log')
  })

  it('builds correct translation prompt with glossary and context', () => {
    const prompt = buildTranslationPrompt('en', 'es', {
      glossary: [
        { source: 'PostgreSQL', target: 'PostgreSQL', type: 'keep_original' },
        { source: 'worker', target: 'trabajador', type: 'technical' },
      ],
      previousContext: 'The system is deployed.',
      documentTitle: 'test.md',
      chunkIndex: 2,
      totalChunks: 5,
      hasTable: true,
    })

    expect(prompt).toContain('en')
    expect(prompt).toContain('es')
    expect(prompt).toContain('PostgreSQL')
    expect(prompt).toContain('trabajador')
    expect(prompt).toContain('The system is deployed.')
    expect(prompt).toContain('chunk 3 of 5')
    expect(prompt).toContain('table')
  })

  it('cost calculation matches expected pricing', () => {
    const cost = calculateCost('gpt-4o-mini', 10_000, 12_000)
    const expected = (10_000 / 1_000_000) * 0.15 + (12_000 / 1_000_000) * 0.60
    expect(cost).toBeCloseTo(expected, 6)
  })

  it('cost calculation falls back to gpt-4o-mini pricing for unknown model', () => {
    const cost = calculateCost('unknown-model', 10_000, 12_000)
    const expected = (10_000 / 1_000_000) * 0.15 + (12_000 / 1_000_000) * 0.60
    expect(cost).toBeCloseTo(expected, 6)
  })

  it('MockProvider records all translation calls in callLog', async () => {
    await provider.translate('Hello', 'en', 'es', {
      glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
    })
    await provider.translate('World', 'en', 'fr', {
      glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false,
    })

    expect(provider.callLog.length).toBe(2)
    expect(provider.callLog[0].text).toBe('Hello')
    expect(provider.callLog[0].targetLang).toBe('es')
    expect(provider.callLog[1].text).toBe('World')
    expect(provider.callLog[1].targetLang).toBe('fr')
  })

  it('translating same content twice produces identical output', async () => {
    const text = 'Hello, this is a test.'
    const ctx = { glossary: [], previousContext: '', documentTitle: null, chunkIndex: 0, totalChunks: 1, hasTable: false }

    const r1 = await provider.translate(text, 'en', 'es', ctx)
    const r2 = await provider.translate(text, 'en', 'es', ctx)

    expect(r1.translatedText).toBe(r2.translatedText)
    expect(r1.costUsd).toBe(r2.costUsd)
  })
})

describe('Translation flow — streaming output', () => {
  it('streaming writer produces markdown output from translated chunks', async () => {
    const { StreamingOutputWriter } = await import('../../src/output/streaming-writer')

    const content = await fs.readFile(path.join(FIXTURES, 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)
    const chunks = await streamChunkBlocks(blocks)
    const translatableChunks = chunks.filter((c) => c.translatable)

    const provider = new MockProvider()
    const tmpDir = path.join(FIXTURES, 'tmp-flow')
    await fs.mkdir(tmpDir, { recursive: true })
    const outPath = path.join(tmpDir, 'streamed.md')

    try {
      const writer = new StreamingOutputWriter(outPath, 'md', {
        title: 'sample', sourceLanguage: 'en', targetLanguage: 'es',
      }, 2)
      await writer.init()

      for (let i = 0; i < translatableChunks.length; i++) {
        const result = await provider.translate(translatableChunks[i].text, 'en', 'es', {
          glossary: [], previousContext: '', documentTitle: 'sample.md',
          chunkIndex: i, totalChunks: translatableChunks.length, hasTable: false,
        })
        await writer.addChunk(i, result.translatedText, {})
      }
      await writer.close()

      const output = await fs.readFile(outPath, 'utf-8')
      expect(output).toContain('[es]')
      expect(output.length).toBeGreaterThan(100)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
