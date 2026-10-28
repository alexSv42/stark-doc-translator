import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { MarkdownParser } from '../../src/parsers/markdown-parser'

const FIXTURES = path.resolve(__dirname, '../fixtures')

describe('MarkdownParser', () => {
  const parser = new MarkdownParser()

  it('canParse returns true for md', () => {
    expect(parser.canParse('md')).toBe(true)
    expect(parser.canParse('pdf')).toBe(false)
  })

  it('parses a markdown file into blocks', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample.md'))

    expect(result.text).toContain('Introduction')
    expect(result.text).toContain('Technical Details')
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.metadata.pageCount).toBe(1)
    expect(result.metadata.parseDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('detects code blocks as non-translatable', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample.md'))
    const codeBlocks = result.blocks.filter((b) => b.type === 'code')
    expect(codeBlocks.length).toBeGreaterThan(0)
    for (const cb of codeBlocks) {
      expect(cb.translatable).toBe(false)
    }
  })

  it('detects headings', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample.md'))
    const headings = result.blocks.filter((b) => b.type === 'heading')
    expect(headings.length).toBeGreaterThan(0)
  })

  it('detects tables', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample.md'))
    const tables = result.blocks.filter((b) => b.type === 'table')
    expect(tables.length).toBeGreaterThan(0)
    expect(tables[0].text).toContain('Feature')
  })

  it('detects lists', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample.md'))
    const lists = result.blocks.filter((b) => b.type === 'list')
    expect(lists.length).toBeGreaterThan(0)
  })

  it('throws NO_EXTRACTABLE_TEXT for empty file', async () => {
    const emptyPath = path.join(FIXTURES, 'empty.md')
    const fs = await import('node:fs/promises')
    await fs.writeFile(emptyPath, '   ')
    await expect(parser.parse(emptyPath)).rejects.toThrow('No text could be extracted')
    await fs.unlink(emptyPath)
  })
})
