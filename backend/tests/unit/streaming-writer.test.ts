import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StreamingOutputWriter } from '../../src/output/streaming-writer'

const TMP_DIR = path.join(__dirname, '..', 'fixtures', 'tmp-streaming')
const META = { title: 'Test', sourceLanguage: 'en', targetLanguage: 'es' }

beforeEach(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
})

describe('StreamingOutputWriter — Markdown', () => {
  it('streams chunks to a markdown file', async () => {
    const outPath = path.join(TMP_DIR, 'stream.md')
    const writer = new StreamingOutputWriter(outPath, 'md', META, 2)
    await writer.init()

    await writer.addChunk(0, 'First paragraph translated.', {})
    await writer.addChunk(1, 'Second paragraph translated.', {})
    // Flush threshold is 2, so these should be flushed already

    await writer.addChunk(2, 'Third paragraph.', {})
    await writer.close()

    const content = await fs.readFile(outPath, 'utf-8')
    expect(content).toContain('First paragraph')
    expect(content).toContain('Second paragraph')
    expect(content).toContain('Third paragraph')
    expect(writer.chunksWritten).toBe(3)
  })

  it('handles single chunk', async () => {
    const outPath = path.join(TMP_DIR, 'single.md')
    const writer = new StreamingOutputWriter(outPath, 'md', META, 5)
    await writer.init()

    await writer.addChunk(0, 'Only chunk.', {})
    await writer.close()

    const content = await fs.readFile(outPath, 'utf-8')
    expect(content).toBe('Only chunk.')
  })

  it('flushes on threshold', async () => {
    const outPath = path.join(TMP_DIR, 'threshold.md')
    const writer = new StreamingOutputWriter(outPath, 'md', META, 2)
    await writer.init()

    await writer.addChunk(0, 'Chunk A.', {})
    // Not flushed yet (threshold is 2)

    await writer.addChunk(1, 'Chunk B.', {})
    // Should be flushed now

    // File should have content even before close
    await new Promise((r) => setTimeout(r, 50))
    const midContent = await fs.readFile(outPath, 'utf-8')
    expect(midContent).toContain('Chunk A.')
    expect(midContent).toContain('Chunk B.')

    await writer.close()
  })
})

describe('StreamingOutputWriter — PDF', () => {
  it('accumulates chunks and generates PDF on close', async () => {
    const outPath = path.join(TMP_DIR, 'stream.pdf')
    const writer = new StreamingOutputWriter(outPath, 'pdf', META, 2)
    await writer.init()

    await writer.addChunk(0, 'First PDF paragraph.', { blockTypes: ['paragraph'] })
    await writer.addChunk(1, 'Second PDF paragraph.', { blockTypes: ['paragraph'] })
    await writer.close()

    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)

    // Verify it's a valid PDF
    const buffer = await fs.readFile(outPath)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
    expect(writer.chunksWritten).toBe(2)
  })
})

describe('StreamingOutputWriter — DOCX', () => {
  it('accumulates chunks and generates DOCX on close', async () => {
    const outPath = path.join(TMP_DIR, 'stream.docx')
    const writer = new StreamingOutputWriter(outPath, 'docx', META, 2)
    await writer.init()

    await writer.addChunk(0, 'First DOCX paragraph.', { blockTypes: ['paragraph'] })
    await writer.addChunk(1, '## Heading\n\nSecond paragraph.', { blockTypes: ['heading', 'paragraph'] })
    await writer.close()

    const stats = await fs.stat(outPath)
    expect(stats.size).toBeGreaterThan(100)

    // Verify it's a valid DOCX (ZIP magic bytes)
    const buffer = await fs.readFile(outPath)
    expect(buffer[0]).toBe(0x50) // P
    expect(buffer[1]).toBe(0x4B) // K
  })
})

describe('StreamingOutputWriter — empty', () => {
  it('handles zero chunks gracefully for markdown', async () => {
    const outPath = path.join(TMP_DIR, 'empty.md')
    const writer = new StreamingOutputWriter(outPath, 'md', META)
    await writer.init()
    await writer.close()

    const content = await fs.readFile(outPath, 'utf-8')
    expect(content).toBe('')
    expect(writer.chunksWritten).toBe(0)
  })
})
