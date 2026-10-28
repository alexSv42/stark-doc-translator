import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TranslatedChunk } from '../../src/output/index'

const TMP_DIR = path.join(__dirname, '..', 'fixtures', 'tmp-output')

beforeEach(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
})

const sampleChunks: TranslatedChunk[] = [
  {
    chunkIndex: 0,
    sourceText: '# Introduction\n\nThis is a sample document.',
    translatedText: '# Introducción\n\nEste es un documento de ejemplo.',
    metadata: { hasTable: false, hasCode: false, blockTypes: ['heading', 'paragraph'] },
  },
  {
    chunkIndex: 1,
    sourceText: 'Second paragraph with **bold** and *italic* text.',
    translatedText: 'Segundo párrafo con **negrita** y *cursiva*.',
    metadata: { hasTable: false, hasCode: false, blockTypes: ['paragraph'] },
  },
  {
    chunkIndex: 2,
    sourceText: '| Header A | Header B |\n|---|---|\n| Cell 1 | Cell 2 |',
    translatedText: '| Encabezado A | Encabezado B |\n|---|---|\n| Celda 1 | Celda 2 |',
    metadata: { hasTable: true, hasCode: false, blockTypes: ['table'] },
  },
]

const sampleMetadata = { title: 'Test Document', sourceLanguage: 'en', targetLanguage: 'es' }

describe('MarkdownOutputGenerator', () => {
  test('generates a markdown file with chunks in order', async () => {
    const { MarkdownOutputGenerator } = await import('../../src/output/markdown-output')
    const gen = new MarkdownOutputGenerator()
    const outPath = path.join(TMP_DIR, 'test.md')

    const result = await gen.generate(sampleChunks, outPath, sampleMetadata)

    expect(result.outputPath).toBe(outPath)
    expect(result.assembleDurationMs).toBeGreaterThanOrEqual(0)

    const content = await fs.readFile(outPath, 'utf-8')
    expect(content).toContain('# Introducción')
    expect(content).toContain('Segundo párrafo')
    expect(content).toContain('Encabezado A')
  })

  test('preserves code blocks untranslated', async () => {
    const { MarkdownOutputGenerator } = await import('../../src/output/markdown-output')
    const gen = new MarkdownOutputGenerator()
    const outPath = path.join(TMP_DIR, 'code.md')

    const chunksWithCode: TranslatedChunk[] = [
      {
        chunkIndex: 0,
        sourceText: '```js\nconsole.log("hello")\n```',
        translatedText: '```js\nconsole.log("hello")\n```',
        metadata: { hasCode: true, blockTypes: ['code'] },
      },
      {
        chunkIndex: 1,
        sourceText: 'Some text.',
        translatedText: 'Algo de texto.',
        metadata: { blockTypes: ['paragraph'] },
      },
    ]

    await gen.generate(chunksWithCode, outPath, sampleMetadata)
    const content = await fs.readFile(outPath, 'utf-8')
    expect(content).toContain('console.log("hello")')
    expect(content).toContain('Algo de texto.')
  })

  test('handles chunks out of order', async () => {
    const { MarkdownOutputGenerator } = await import('../../src/output/markdown-output')
    const gen = new MarkdownOutputGenerator()
    const outPath = path.join(TMP_DIR, 'order.md')

    const reversed = [...sampleChunks].reverse()
    await gen.generate(reversed, outPath, sampleMetadata)
    const content = await fs.readFile(outPath, 'utf-8')

    const introIdx = content.indexOf('Introducción')
    const secondIdx = content.indexOf('Segundo')
    const tableIdx = content.indexOf('Encabezado')
    expect(introIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(tableIdx)
  })
})

describe('PdfOutputGenerator', () => {
  test('generates a valid PDF file', async () => {
    const { PdfOutputGenerator } = await import('../../src/output/pdf-output')
    const gen = new PdfOutputGenerator()
    const outPath = path.join(TMP_DIR, 'test.pdf')

    const result = await gen.generate(sampleChunks, outPath, sampleMetadata)

    expect(result.outputPath).toBe(outPath)
    expect(result.assembleDurationMs).toBeGreaterThanOrEqual(0)

    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)

    // Check PDF magic bytes
    const buffer = await fs.readFile(outPath)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  })

  test('sets PDF metadata', async () => {
    const { PdfOutputGenerator } = await import('../../src/output/pdf-output')
    const { PDFDocument } = await import('pdf-lib')
    const gen = new PdfOutputGenerator()
    const outPath = path.join(TMP_DIR, 'meta.pdf')

    await gen.generate(sampleChunks, outPath, sampleMetadata)
    const buffer = await fs.readFile(outPath)
    const loadedPdf = await PDFDocument.load(buffer)
    expect(loadedPdf.getTitle()).toBe('Test Document')
  })

  test('handles empty chunks gracefully', async () => {
    const { PdfOutputGenerator } = await import('../../src/output/pdf-output')
    const gen = new PdfOutputGenerator()
    const outPath = path.join(TMP_DIR, 'empty.pdf')

    await gen.generate([], outPath, sampleMetadata)
    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(0)
  })

  test('handles long text that spans multiple pages', async () => {
    const { PdfOutputGenerator } = await import('../../src/output/pdf-output')
    const gen = new PdfOutputGenerator()
    const outPath = path.join(TMP_DIR, 'long.pdf')

    const longText = 'Lorem ipsum dolor sit amet. '.repeat(500)
    const longChunks: TranslatedChunk[] = [{
      chunkIndex: 0,
      sourceText: longText,
      translatedText: longText,
      metadata: { blockTypes: ['paragraph'] },
    }]

    const result = await gen.generate(longChunks, outPath, sampleMetadata)
    expect(result.assembleDurationMs).toBeGreaterThanOrEqual(0)

    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(1000)
  })
})

describe('DocxOutputGenerator', () => {
  test('generates a valid DOCX file', async () => {
    const { DocxOutputGenerator } = await import('../../src/output/docx-output')
    const gen = new DocxOutputGenerator()
    const outPath = path.join(TMP_DIR, 'test.docx')

    const result = await gen.generate(sampleChunks, outPath, sampleMetadata)

    expect(result.outputPath).toBe(outPath)
    expect(result.assembleDurationMs).toBeGreaterThanOrEqual(0)

    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)

    // DOCX is a ZIP, check magic bytes (PK)
    const buffer = await fs.readFile(outPath)
    expect(buffer[0]).toBe(0x50) // P
    expect(buffer[1]).toBe(0x4B) // K
  })

  test('handles headings correctly', async () => {
    const { DocxOutputGenerator } = await import('../../src/output/docx-output')
    const gen = new DocxOutputGenerator()
    const outPath = path.join(TMP_DIR, 'headings.docx')

    const headingChunks: TranslatedChunk[] = [{
      chunkIndex: 0,
      sourceText: '# Title',
      translatedText: '# Título\n\n## Subtítulo\n\nContenido del párrafo.',
      metadata: { blockTypes: ['heading', 'paragraph'] },
    }]

    await gen.generate(headingChunks, outPath, sampleMetadata)
    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)
  })

  test('handles tables in translated text', async () => {
    const { DocxOutputGenerator } = await import('../../src/output/docx-output')
    const gen = new DocxOutputGenerator()
    const outPath = path.join(TMP_DIR, 'tables.docx')

    const tableChunks: TranslatedChunk[] = [{
      chunkIndex: 0,
      sourceText: '| A | B |\n|---|---|\n| 1 | 2 |',
      translatedText: '| A | B |\n|---|---|\n| 1 | 2 |',
      metadata: { hasTable: true, blockTypes: ['table'] },
    }]

    await gen.generate(tableChunks, outPath, sampleMetadata)
    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)
  })

  test('handles empty chunks', async () => {
    const { DocxOutputGenerator } = await import('../../src/output/docx-output')
    const gen = new DocxOutputGenerator()
    const outPath = path.join(TMP_DIR, 'empty.docx')

    await gen.generate([], outPath, sampleMetadata)
    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(0)
  })

  test('handles lists', async () => {
    const { DocxOutputGenerator } = await import('../../src/output/docx-output')
    const gen = new DocxOutputGenerator()
    const outPath = path.join(TMP_DIR, 'lists.docx')

    const listChunks: TranslatedChunk[] = [{
      chunkIndex: 0,
      sourceText: '- Item 1\n- Item 2\n- Item 3',
      translatedText: '- Elemento 1\n- Elemento 2\n- Elemento 3',
      metadata: { blockTypes: ['list'] },
    }]

    await gen.generate(listChunks, outPath, sampleMetadata)
    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)
  })
})

describe('getOutputGenerator', () => {
  test('returns correct generator for each format', async () => {
    const { getOutputGenerator } = await import('../../src/output/index')

    const pdf = await getOutputGenerator('pdf')
    expect(pdf.format).toBe('pdf')

    const docx = await getOutputGenerator('docx')
    expect(docx.format).toBe('docx')

    const md = await getOutputGenerator('md')
    expect(md.format).toBe('md')
  })

  test('throws for unknown format', async () => {
    const { getOutputGenerator } = await import('../../src/output/index')
    await expect(getOutputGenerator('txt')).rejects.toThrow("No output generator for format 'txt'")
  })
})
