import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { DocxParser } from '../../src/parsers/docx-parser'

const FIXTURES = path.join(__dirname, '..', 'fixtures')

describe('DocxParser', () => {
  it('parses a valid docx file', async () => {
    const parser = new DocxParser()
    const result = await parser.parse(path.join(FIXTURES, 'sample.docx'))

    expect(result.text.length).toBeGreaterThan(50)
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.metadata.pageCount).toBeGreaterThanOrEqual(1)
    expect(result.metadata.parseDurationMs).toBeGreaterThanOrEqual(0)
    expect(result.metadata.estimatedTokens).toBeGreaterThan(0)
    expect(result.metadata.isScanned).toBe(false)
  })

  it('produces translatable blocks from docx', async () => {
    const parser = new DocxParser()
    const result = await parser.parse(path.join(FIXTURES, 'sample.docx'))

    const translatableBlocks = result.blocks.filter((b) => b.translatable)
    expect(translatableBlocks.length).toBeGreaterThan(0)
  })

  it('canParse returns true only for docx', () => {
    const parser = new DocxParser()
    expect(parser.canParse('docx')).toBe(true)
    expect(parser.canParse('pdf')).toBe(false)
    expect(parser.canParse('md')).toBe(false)
    expect(parser.canParse('txt')).toBe(false)
  })

  it('throws CORRUPT_FILE for invalid file', async () => {
    const parser = new DocxParser()
    const tmpDir = path.join(FIXTURES, 'tmp-docx')
    await fs.mkdir(tmpDir, { recursive: true })
    const fakePath = path.join(tmpDir, 'fake.docx')
    await fs.writeFile(fakePath, 'this is not a docx file')

    try {
      await expect(parser.parse(fakePath)).rejects.toThrow('corrupted')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('text extraction includes headings and paragraphs', async () => {
    const parser = new DocxParser()
    const result = await parser.parse(path.join(FIXTURES, 'sample.docx'))

    expect(result.text.toLowerCase()).toContain('introduction')
    expect(result.text.toLowerCase()).toContain('postgresql')
  })
})
