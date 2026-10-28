import { Injectable } from '@nestjs/common'
import crypto from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { translationCache } from '../db/schema'
import { createChildLogger } from '../lib/logger'
import type { TranslationResult } from './provider'

const log = createChildLogger('translation-cache')

@Injectable()
export class TranslationCacheService {
  constructor(private db: DatabaseService) {}

  contentHash(text: string, sourceLang: string, targetLang: string): string {
    return crypto
      .createHash('sha256')
      .update(`${sourceLang}:${targetLang}:${text}`)
      .digest('hex')
  }

  async lookup(text: string, sourceLang: string, targetLang: string): Promise<TranslationResult | null> {
    const hash = this.contentHash(text, sourceLang, targetLang)
    const drizzleDb = this.db.getDb()

    const [cached] = await drizzleDb
      .select()
      .from(translationCache)
      .where(
        and(
          eq(translationCache.contentHash, hash),
          eq(translationCache.sourceLanguage, sourceLang),
          eq(translationCache.targetLanguage, targetLang),
        ),
      )

    if (!cached) return null

    log.debug({ hash: hash.slice(0, 12) }, 'cache hit')
    return {
      translatedText: cached.translatedText,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: cached.modelUsed,
      durationMs: 0,
      fromCache: true,
    }
  }

  async store(
    text: string,
    sourceLang: string,
    targetLang: string,
    translatedText: string,
    model: string,
  ): Promise<void> {
    const hash = this.contentHash(text, sourceLang, targetLang)
    const drizzleDb = this.db.getDb()

    try {
      await drizzleDb.insert(translationCache).values({
        contentHash: hash,
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        sourceText: text,
        translatedText,
        modelUsed: model,
      }).onConflictDoNothing()

      log.debug({ hash: hash.slice(0, 12) }, 'cached translation stored')
    } catch (err) {
      // Unique constraint violation is fine — another worker cached it first
      log.debug({ err: (err as Error).message }, 'cache store conflict (already cached)')
    }
  }
}
