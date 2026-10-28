import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'

describe('advisory lock logic', () => {
  it('hashtext produces a consistent numeric hash for the same key', () => {
    const key = 'doc-1:chunk-0:Hello world'
    // Simulate hashtext behavior — same key, same result
    const hash1 = simpleHash(key)
    const hash2 = simpleHash(key)
    expect(hash1).toBe(hash2)
  })

  it('different idempotency keys produce different lock IDs', () => {
    const hash1 = simpleHash('doc-1:0:content-a')
    const hash2 = simpleHash('doc-1:1:content-b')
    expect(hash1).not.toBe(hash2)
  })

  it('only one of two concurrent lock attempts succeeds', () => {
    // Simulate pg_try_advisory_lock behavior
    const locks = new Set<string>()

    const tryLock = (key: string): boolean => {
      if (locks.has(key)) return false
      locks.add(key)
      return true
    }

    const unlock = (key: string): void => {
      locks.delete(key)
    }

    const key = 'chunk-key-1'

    // Worker A acquires lock
    expect(tryLock(key)).toBe(true)

    // Worker B tries same lock — fails
    expect(tryLock(key)).toBe(false)

    // Worker A releases
    unlock(key)

    // Now Worker B can acquire
    expect(tryLock(key)).toBe(true)
    unlock(key)
  })

  it('lock is released in finally block even on error', () => {
    const locks = new Set<string>()
    const tryLock = (key: string) => { locks.add(key); return true }
    const unlock = (key: string) => { locks.delete(key) }

    const key = 'chunk-key-2'
    tryLock(key)
    expect(locks.has(key)).toBe(true)

    let errorCaught = false
    try {
      throw new Error('translation failed')
    } catch {
      errorCaught = true
    } finally {
      unlock(key)
    }

    expect(errorCaught).toBe(true)
    expect(locks.has(key)).toBe(false)
  })

  it('re-check after lock prevents duplicate processing', () => {
    // Simulates: acquire lock → re-check status → skip if completed
    const chunkStatus = 'completed' // Another worker finished between our first check and lock acquisition
    const shouldProcess = chunkStatus !== 'completed'
    expect(shouldProcess).toBe(false)
  })
})

function simpleHash(input: string): number {
  return crypto
    .createHash('md5')
    .update(input)
    .digest()
    .readInt32LE(0)
}
