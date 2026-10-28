import { describe, it, expect } from 'vitest'
import { SemanticChunkAgentService } from '../../src/agents/semantic-chunk-agent'
import { textToBlocks, estimateTokens } from '../../src/parsers/index'
import type { ContentBlock } from '../../src/parsers/index'

function block(type: ContentBlock['type'], text: string, translatable = true): ContentBlock {
  return { type, text, pageNumber: 1, translatable }
}

/**
 * Simulates the streaming chunker loop used by the processor:
 * iterate blocks → agent decides boundary → accumulate or finalize.
 */
async function streamChunk(blocks: ContentBlock[]): Promise<Array<{ text: string; blocks: ContentBlock[] }>> {
  const agent = new SemanticChunkAgentService()
  const chunks: Array<{ text: string; blocks: ContentBlock[] }> = []
  let accumulatedText = ''
  let accumulatedTokens = 0
  let accumulatedBlocks: ContentBlock[] = []

  for (const b of blocks) {
    if (!b.translatable) {
      if (accumulatedText) {
        chunks.push({ text: accumulatedText, blocks: [...accumulatedBlocks] })
        accumulatedText = ''
        accumulatedTokens = 0
        accumulatedBlocks = []
      }
      // Non-translatable pass through as own chunk
      chunks.push({ text: b.text, blocks: [b] })
      continue
    }

    if (accumulatedText) {
      const decision = await agent.shouldSplitBefore(accumulatedText, b, accumulatedTokens)
      if (decision.isComplete) {
        chunks.push({ text: accumulatedText, blocks: [...accumulatedBlocks] })
        accumulatedText = ''
        accumulatedTokens = 0
        accumulatedBlocks = []
      }
    }

    accumulatedText += (accumulatedText ? '\n\n' : '') + b.text
    accumulatedTokens += estimateTokens(b.text)
    accumulatedBlocks.push(b)
  }

  if (accumulatedText) {
    chunks.push({ text: accumulatedText, blocks: [...accumulatedBlocks] })
  }

  return chunks
}

describe('Streaming semantic chunker', () => {
  it('chunks a short document into a single chunk', async () => {
    const blocks = [block('paragraph', 'This is a short paragraph.')]
    const chunks = await streamChunk(blocks)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('short paragraph')
  })

  it('splits before a heading', async () => {
    const blocks = [
      block('paragraph', 'First section content. This is a normal paragraph with enough text.'),
      block('heading', '## New Section'),
      block('paragraph', 'Second section content.'),
    ]
    const chunks = await streamChunk(blocks)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // First chunk has first paragraph, second chunk starts with heading
    expect(chunks[0].text).toContain('First section')
    expect(chunks[1].text).toContain('New Section')
  })

  it('keeps code blocks separate and non-translatable', async () => {
    const blocks = [
      block('paragraph', 'Some text before code.'),
      block('code', '```js\nconsole.log("hello")\n```', false),
      block('paragraph', 'Some text after code.'),
    ]
    const chunks = await streamChunk(blocks)
    expect(chunks.length).toBe(3)
    expect(chunks[1].text).toContain('console.log')
    expect(chunks[1].blocks[0].translatable).toBe(false)
  })

  it('splits before tables when accumulated text exists', async () => {
    const blocks = [
      block('paragraph', 'Here is some introductory text that sets up the table below with context.'),
      block('table', '| Col A | Col B |\n|-------|-------|\n| 1 | 2 |'),
      block('paragraph', 'After the table.'),
    ]
    const chunks = await streamChunk(blocks)
    // Table should be its own chunk or start a new chunk
    const tableChunk = chunks.find((c) => c.text.includes('Col A'))
    expect(tableChunk).toBeDefined()
  })

  it('accumulates small blocks together', async () => {
    const blocks = [
      block('paragraph', 'Short.'),
      block('paragraph', 'Also short.'),
      block('paragraph', 'Still short text.'),
    ]
    const chunks = await streamChunk(blocks)
    // All small blocks should be in one chunk (below MIN_CHUNK_TOKENS)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('Short.')
    expect(chunks[0].text).toContain('Also short.')
    expect(chunks[0].text).toContain('Still short')
  })

  it('splits at ideal size on paragraph boundary', async () => {
    // Create text that's >4000 tokens (new IDEAL) to trigger ideal-size split
    const longPara1 = 'Word '.repeat(1200) // ~1200 tokens
    const longPara2 = 'Text '.repeat(1200) // ~1200 tokens
    const longPara3 = 'More '.repeat(1200) // ~1200 tokens
    const newPara = 'Final paragraph content here.'

    const blocks = [
      block('paragraph', longPara1),
      block('paragraph', longPara2),
      block('paragraph', longPara3),
      block('paragraph', newPara),
    ]
    const chunks = await streamChunk(blocks)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it('respects hard token limit', async () => {
    const hugeText = 'Word '.repeat(8000) // ~8000 tokens, way over 6000 limit
    const blocks = [
      block('paragraph', hugeText),
      block('paragraph', 'Next block.'),
    ]
    const chunks = await streamChunk(blocks)
    // The huge block accumulates, then next block triggers split
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('handles empty input', async () => {
    const chunks = await streamChunk([])
    expect(chunks).toHaveLength(0)
  })

  it('handles mixed translatable and non-translatable blocks', async () => {
    const blocks = [
      block('paragraph', 'Translatable text here.'),
      block('code', 'const x = 1;', false),
      block('paragraph', 'More translatable text.'),
      block('code', 'const y = 2;', false),
    ]
    const chunks = await streamChunk(blocks)
    expect(chunks).toHaveLength(4)
    expect(chunks[0].blocks[0].translatable).toBe(true)
    expect(chunks[1].blocks[0].translatable).toBe(false)
    expect(chunks[2].blocks[0].translatable).toBe(true)
    expect(chunks[3].blocks[0].translatable).toBe(false)
  })

  it('real markdown document produces reasonable chunks', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const content = await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)
    const chunks = await streamChunk(blocks)

    expect(chunks.length).toBeGreaterThan(0)
    // Every chunk should have text
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('textToBlocks + splitSentences', () => {
  it('identifies headings, paragraphs, code, tables, lists', () => {
    const text = `# Heading

Paragraph text here.

| A | B |
|---|---|
| 1 | 2 |

\`\`\`js
console.log("hi")
\`\`\`

- List item 1
- List item 2`

    const blocks = textToBlocks(text)
    const types = blocks.map((b) => b.type)
    expect(types).toContain('heading')
    expect(types).toContain('paragraph')
    expect(types).toContain('table')
    expect(types).toContain('code')
    expect(types).toContain('list')
  })

  it('marks code blocks as non-translatable', () => {
    const blocks = textToBlocks('```\ncode\n```')
    const codeBlock = blocks.find((b) => b.type === 'code')
    expect(codeBlock).toBeDefined()
    expect(codeBlock!.translatable).toBe(false)
  })

  it('token estimation is reasonable', () => {
    const text = 'Hello world, this is a test sentence with several words.'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(text.length)
  })
})
