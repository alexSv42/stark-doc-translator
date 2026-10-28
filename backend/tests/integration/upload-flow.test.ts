import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateFile, validateMagicBytes, validateFileSize } from '../../src/lib/security'
import { AppError, Errors } from '../../src/lib/errors'
import { textToBlocks, estimateTokens } from '../../src/parsers/index'
import { SemanticChunkAgentService } from '../../src/agents/semantic-chunk-agent'

const FIXTURES = path.join(__dirname, '..', 'fixtures')

describe('Upload flow — validation', () => {
  it('accepts a valid PDF file', async () => {
    const filePath = path.join(FIXTURES, 'sample-5page.pdf')
    await expect(validateFile(filePath, 'pdf', 100 * 1024 * 1024)).resolves.not.toThrow()
  })

  it('accepts a valid DOCX file', async () => {
    const filePath = path.join(FIXTURES, 'sample.docx')
    await expect(validateFile(filePath, 'docx', 100 * 1024 * 1024)).resolves.not.toThrow()
  })

  it('accepts a markdown file (no magic bytes check)', async () => {
    const filePath = path.join(FIXTURES, 'sample.md')
    await expect(validateFile(filePath, 'md', 100 * 1024 * 1024)).resolves.not.toThrow()
  })

  it('rejects a file with wrong magic bytes', async () => {
    const tmpDir = path.join(FIXTURES, 'tmp-upload')
    await fs.mkdir(tmpDir, { recursive: true })
    const fakePdf = path.join(tmpDir, 'fake.pdf')
    await fs.writeFile(fakePdf, 'this is not a PDF')

    try {
      await expect(validateMagicBytes(fakePdf, 'pdf')).rejects.toThrow('security validation')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects an empty file', async () => {
    const tmpDir = path.join(FIXTURES, 'tmp-upload')
    await fs.mkdir(tmpDir, { recursive: true })
    const emptyFile = path.join(tmpDir, 'empty.pdf')
    await fs.writeFile(emptyFile, '')

    try {
      await expect(validateFileSize(emptyFile, 100 * 1024 * 1024)).rejects.toThrow('corrupted')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects a file exceeding size limit', async () => {
    const filePath = path.join(FIXTURES, 'sample-5page.pdf')
    await expect(validateFileSize(filePath, 1)).rejects.toThrow('100 MB')
  })
})

describe('Upload flow — format detection', () => {
  it('maps .pdf to pdf format', () => {
    const format = path.extname('report.pdf').toLowerCase().slice(1)
    expect(['pdf', 'docx', 'md']).toContain(format)
  })

  it('rejects unsupported format', () => {
    const err = Errors.unsupportedFormat('txt')
    expect(err.code).toBe('UNSUPPORTED_FORMAT')
    expect(err.getStatus()).toBe(415)
  })
})

describe('Upload flow — parse + chunk pipeline', () => {
  it('parses markdown and produces blocks', async () => {
    const content = await fs.readFile(path.join(FIXTURES, 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)

    expect(blocks.length).toBeGreaterThan(0)
    const types = blocks.map((b) => b.type)
    expect(types).toContain('heading')
    expect(types).toContain('paragraph')
  })

  it('markdown code blocks are not translatable', async () => {
    const content = await fs.readFile(path.join(FIXTURES, 'sample.md'), 'utf-8')
    const blocks = textToBlocks(content)

    const codeBlocks = blocks.filter((b) => b.type === 'code')
    expect(codeBlocks.length).toBeGreaterThan(0)
    for (const block of codeBlocks) {
      expect(block.translatable).toBe(false)
    }
  })

  it('idempotency keys are deterministic (same input = same key)', () => {
    const docId = 'test-doc-id'
    const chunkIndex = 0
    const text = 'Hello world, this is chunk content.'

    const key1 = crypto.createHash('sha256').update(`${docId}:${chunkIndex}:${text.slice(0, 100)}`).digest('hex').slice(0, 64)
    const key2 = crypto.createHash('sha256').update(`${docId}:${chunkIndex}:${text.slice(0, 100)}`).digest('hex').slice(0, 64)

    expect(key1).toBe(key2)
    expect(key1.length).toBe(64)
  })

  it('different documentId → different idempotency keys', () => {
    const text = 'Same content.'
    const key1 = crypto.createHash('sha256').update(`doc-1:0:${text.slice(0, 100)}`).digest('hex').slice(0, 64)
    const key2 = crypto.createHash('sha256').update(`doc-2:0:${text.slice(0, 100)}`).digest('hex').slice(0, 64)

    expect(key1).not.toBe(key2)
  })

  it('token estimation is reasonable', () => {
    const text = 'Hello world, this is a test sentence.'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(text.length)
  })
})
