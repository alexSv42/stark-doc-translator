import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { PdfParser } from '../../src/parsers/pdf-parser'

const FIXTURES = path.resolve(__dirname, '../fixtures')

describe('PdfParser', () => {
  const parser = new PdfParser()

  it('canParse returns true for pdf', () => {
    expect(parser.canParse('pdf')).toBe(true)
    expect(parser.canParse('docx')).toBe(false)
  })

  it('throws CORRUPT_FILE for a non-PDF file', async () => {
    await expect(parser.parse(path.join(FIXTURES, 'sample-corrupted.pdf'))).rejects.toThrow('corrupted')
  })

  it('throws CORRUPT_FILE for a non-existent file', async () => {
    await expect(parser.parse('/nonexistent/file.pdf')).rejects.toThrow()
  })

  it('parses a 100-page PDF with extractable text', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample-200-pages.pdf'))

    expect(result.metadata.pageCount).toBe(100)
    expect(result.blocks.length).toBeGreaterThan(50)
    expect(result.text.length).toBeGreaterThan(10_000)
    expect(result.text).toContain('sample')
    expect(result.metadata.isScanned).toBe(false)
    expect(result.metadata.parseDurationMs).toBeGreaterThan(0)
  })

  it('parses a 500-page PDF (stress test)', async () => {
    const result = await parser.parse(path.join(FIXTURES, 'sample-large.pdf'))

    expect(result.metadata.pageCount).toBe(500)
    expect(result.blocks.length).toBeGreaterThan(200)
    expect(result.text.length).toBeGreaterThan(100_000)
    expect(result.metadata.isScanned).toBe(false)
  })

  it('throws CORRUPT_FILE for a truncated PDF', async () => {
    await expect(
      parser.parse(path.join(FIXTURES, 'sample-corrupted-real.pdf')),
    ).rejects.toThrow('corrupted')
  })
})
