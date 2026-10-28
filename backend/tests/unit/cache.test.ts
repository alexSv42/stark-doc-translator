import { describe, it, expect, vi } from 'vitest'
import { TranslationCacheService } from '../../src/translation/cache.service'

describe('TranslationCacheService', () => {
  it('contentHash is deterministic for same input', () => {
    const mockDb = { getDb: vi.fn() } as any
    const cache = new TranslationCacheService(mockDb)

    const h1 = cache.contentHash('hello', 'en', 'es')
    const h2 = cache.contentHash('hello', 'en', 'es')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(64)
  })

  it('contentHash differs for different text', () => {
    const mockDb = { getDb: vi.fn() } as any
    const cache = new TranslationCacheService(mockDb)

    const h1 = cache.contentHash('hello', 'en', 'es')
    const h2 = cache.contentHash('world', 'en', 'es')
    expect(h1).not.toBe(h2)
  })

  it('contentHash differs for different language pairs', () => {
    const mockDb = { getDb: vi.fn() } as any
    const cache = new TranslationCacheService(mockDb)

    const h1 = cache.contentHash('hello', 'en', 'es')
    const h2 = cache.contentHash('hello', 'en', 'fr')
    expect(h1).not.toBe(h2)
  })

  it('lookup returns null on cache miss (no DB)', async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
    const mockDb = { getDb: () => ({ select: mockSelect }) } as any
    const cache = new TranslationCacheService(mockDb)

    const result = await cache.lookup('test text', 'en', 'es')
    expect(result).toBeNull()
  })

  it('lookup returns result with zero cost on cache hit', async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          translatedText: 'texto de prueba',
          modelUsed: 'gpt-4o-mini',
        }]),
      }),
    })
    const mockDb = { getDb: () => ({ select: mockSelect }) } as any
    const cache = new TranslationCacheService(mockDb)

    const result = await cache.lookup('test text', 'en', 'es')
    expect(result).not.toBeNull()
    expect(result!.translatedText).toBe('texto de prueba')
    expect(result!.costUsd).toBe(0)
    expect(result!.fromCache).toBe(true)
    expect(result!.inputTokens).toBe(0)
    expect(result!.outputTokens).toBe(0)
  })
})
