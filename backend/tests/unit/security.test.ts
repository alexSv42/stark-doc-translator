import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { validateMagicBytes, validateFileSize } from '../../src/lib/security'

const FIXTURES = path.resolve(__dirname, '../fixtures')
const TMP = path.resolve(__dirname, '../fixtures/tmp')

describe('security', () => {
  beforeAll(async () => {
    await fs.mkdir(TMP, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
  })

  describe('validateMagicBytes', () => {
    it('accepts a valid PDF', async () => {
      const filePath = path.join(FIXTURES, 'sample-5page.pdf')
      await expect(validateMagicBytes(filePath, 'pdf')).resolves.not.toThrow()
    })

    it('rejects a file with wrong magic bytes for PDF', async () => {
      const fakePath = path.join(TMP, 'fake.pdf')
      await fs.writeFile(fakePath, 'this is not a pdf at all')
      await expect(validateMagicBytes(fakePath, 'pdf')).rejects.toThrow('security validation')
    })

    it('skips validation for markdown (no magic bytes)', async () => {
      const mdPath = path.join(FIXTURES, 'sample.md')
      await expect(validateMagicBytes(mdPath, 'md')).resolves.not.toThrow()
    })

    it('rejects a text file pretending to be a DOCX', async () => {
      const fakePath = path.join(TMP, 'fake.docx')
      await fs.writeFile(fakePath, 'just text, not a zip')
      await expect(validateMagicBytes(fakePath, 'docx')).rejects.toThrow('security validation')
    })
  })

  describe('validateFileSize', () => {
    it('accepts a file within limits', async () => {
      const filePath = path.join(FIXTURES, 'sample.md')
      await expect(validateFileSize(filePath, 100 * 1024 * 1024)).resolves.not.toThrow()
    })

    it('rejects a file exceeding limits', async () => {
      const filePath = path.join(FIXTURES, 'sample.md')
      await expect(validateFileSize(filePath, 1)).rejects.toThrow('100 MB')
    })

    it('rejects an empty file', async () => {
      const emptyPath = path.join(TMP, 'empty.bin')
      await fs.writeFile(emptyPath, '')
      await expect(validateFileSize(emptyPath, 100 * 1024 * 1024)).rejects.toThrow('corrupted')
    })
  })
})
