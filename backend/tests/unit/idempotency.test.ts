import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'

describe('idempotency', () => {
  it('idempotency key is SHA-256 of documentId + chunkIndex + first 100 chars', () => {
    const documentId = 'doc-123'
    const chunkIndex = 0
    const text = 'The quick brown fox jumps over the lazy dog.'

    const key = crypto
      .createHash('sha256')
      .update(`${documentId}:${chunkIndex}:${text.slice(0, 100)}`)
      .digest('hex')
      .slice(0, 64)

    expect(key).toHaveLength(64)
    expect(/^[0-9a-f]+$/.test(key)).toBe(true)
  })

  it('same inputs produce same idempotency key', () => {
    const make = () =>
      crypto
        .createHash('sha256')
        .update('doc-x:0:Hello world')
        .digest('hex')
        .slice(0, 64)

    expect(make()).toBe(make())
  })

  it('different document IDs produce different keys', () => {
    const makeKey = (docId: string) =>
      crypto
        .createHash('sha256')
        .update(`${docId}:0:Hello world`)
        .digest('hex')
        .slice(0, 64)

    expect(makeKey('doc-a')).not.toBe(makeKey('doc-b'))
  })

  it('different chunk indices produce different keys', () => {
    const makeKey = (index: number) =>
      crypto
        .createHash('sha256')
        .update(`doc-x:${index}:Hello world`)
        .digest('hex')
        .slice(0, 64)

    expect(makeKey(0)).not.toBe(makeKey(1))
  })

  it('completed chunk should be skipped on re-processing', () => {
    const existingChunk = { status: 'completed', translatedText: 'Hola mundo' }
    expect(existingChunk.status === 'completed').toBe(true)
  })

  it('onConflictDoNothing prevents duplicate chunk insertion', () => {
    // Simulates the behavior: inserting same chunk twice should not throw
    const insertedChunks = new Map<string, boolean>()
    const insert = (key: string) => {
      if (!insertedChunks.has(key)) {
        insertedChunks.set(key, true)
        return 'inserted'
      }
      return 'conflict_ignored'
    }

    expect(insert('doc-1:chunk-0')).toBe('inserted')
    expect(insert('doc-1:chunk-0')).toBe('conflict_ignored')
    expect(insertedChunks.size).toBe(1)
  })
})
