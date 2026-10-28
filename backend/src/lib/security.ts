import fs from 'node:fs/promises'
import { AppError } from './errors'
import { createChildLogger } from './logger'

const log = createChildLogger('security')

const MAGIC_BYTES: Record<string, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46],
  docx: [0x50, 0x4b, 0x03, 0x04],
}

export async function validateMagicBytes(filePath: string, format: string): Promise<void> {
  const expected = MAGIC_BYTES[format]
  if (!expected) return

  const fd = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(expected.length)
    await fd.read(buf, 0, expected.length, 0)
    for (let i = 0; i < expected.length; i++) {
      if (buf[i] !== expected[i]) {
        log.warn({ filePath, format, expected: Buffer.from(expected).toString('hex'), got: buf.toString('hex') }, 'magic bytes mismatch')
        throw new AppError('SECURITY_VIOLATION', 422, 'This file failed security validation.')
      }
    }
  } finally {
    await fd.close()
  }
}

export async function validateFileSize(filePath: string, maxBytes: number): Promise<void> {
  const stat = await fs.stat(filePath)
  if (stat.size > maxBytes) {
    throw new AppError('FILE_TOO_LARGE', 413, 'File exceeds the 100 MB limit.')
  }
  if (stat.size === 0) {
    throw new AppError('CORRUPT_FILE', 422, 'This file is corrupted and cannot be opened.')
  }
}

export async function validateFile(filePath: string, format: string, maxSizeBytes: number): Promise<void> {
  await validateFileSize(filePath, maxSizeBytes)
  await validateMagicBytes(filePath, format)
}
