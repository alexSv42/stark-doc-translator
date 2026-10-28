import { Injectable } from '@nestjs/common'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Job } from 'bullmq'
import { eq, sql, and } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { documents, translationChunks } from '../db/schema'
import { TranslationAgentService } from '../agents/translation-agent'
import { SemanticChunkAgentService } from '../agents/semantic-chunk-agent'
import { getParser } from '../parsers/index'
import type { ContentBlock } from '../parsers/index'
import { StreamingOutputWriter } from '../output/streaming-writer'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'
import { captureTranslationError } from '../lib/sentry'
import type { TranslationJobData } from './queue.service'

const log = createChildLogger('translation-job')

const RETRIABLE_CODES = new Set(['RATE_LIMITED', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT'])
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 1000
const OUTPUT_FLUSH_EVERY = 3

@Injectable()
export class TranslationJobProcessor {
  constructor(
    private db: DatabaseService,
    private translationAgent: TranslationAgentService,
    private semanticChunker: SemanticChunkAgentService,
  ) {}

  async process(job: Job<TranslationJobData>): Promise<void> {
    const { documentId } = job.data
    const drizzleDb = this.db.getDb()

    log.info({ documentId, jobId: job.id }, 'starting translation job')

    const [doc] = await drizzleDb.select().from(documents).where(eq(documents.id, documentId))
    if (!doc) {
      log.error({ documentId }, 'document not found')
      return
    }

    // Skip if already completed or failed (prevents duplicate work
    // when both proactive resume and BullMQ stalled retry fire)
    if (doc.status === 'completed' || doc.status === 'failed') {
      log.info({ documentId, status: doc.status, jobId: job.id }, 'document already in terminal state — skipping')
      return
    }

    try {
      await this.processStreaming(documentId, doc, drizzleDb)
    } catch (err) {
      log.error({ documentId, err: (err as Error).message, stack: (err as Error).stack }, 'processStreaming crashed')
      captureTranslationError(err as Error, { documentId, phase: 'translate' })
      await drizzleDb
        .update(documents)
        .set({ status: 'failed', errorCode: 'INTERNAL_ERROR', errorMessage: (err as Error).message, updatedAt: new Date() })
        .where(eq(documents.id, documentId))
      throw err
    }
  }

  /**
   * Two-pass parallel pipeline:
   *   1. Parse → plan chunks → glossary (once)
   *   2. Translate all chunks in parallel (concurrency 4) → assemble output
   *
   * Crash resume: chunk-level idempotency in PostgreSQL + BullMQ stalled detection.
   */
  private async processStreaming(documentId: string, doc: any, drizzleDb: any): Promise<void> {
    const startedAt = new Date()

    await drizzleDb
      .update(documents)
      .set({ status: 'analyzing', startedAt, updatedAt: new Date() })
      .where(eq(documents.id, documentId))

    // ── Pass 1: Parse & Plan ────────────────────────────────────────────
    let parsedText: string
    let plannedChunks: import('../agents/semantic-chunk-agent').PlannedChunk[]

    try {
      const parser = await getParser(doc.format)
      const parsed = await parser.parse(doc.storagePath)
      parsedText = parsed.text

      // Plan all chunk boundaries in one pass (O(n), zero tokens)
      plannedChunks = await this.semanticChunker.planChunks(parsed.blocks)

      await drizzleDb
        .update(documents)
        .set({
          pageCount: parsed.metadata.pageCount,
          parseDurationMs: parsed.metadata.parseDurationMs,
          totalChunks: plannedChunks.length,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))

      log.info({ documentId, blockCount: parsed.blocks.length, totalChunks: plannedChunks.length }, 'document parsed and chunked')
    } catch (err) {
      log.error({ documentId, err: (err as Error).message }, 'parse failed')
      await drizzleDb
        .update(documents)
        .set({ status: 'failed', errorCode: 'PARSE_FAILED', errorMessage: (err as Error).message, updatedAt: new Date() })
        .where(eq(documents.id, documentId))
      return
    }

    // Glossary extraction (phase 1 — graceful degradation)
    const sourceLang = doc.sourceLanguage || 'en'
    const targetLang = doc.targetLanguage

    try {
      await this.translationAgent.extractGlossary(parsedText, documentId, sourceLang, targetLang)
    } catch (err) {
      log.warn({ documentId, err: (err as Error).message }, 'glossary extraction failed — continuing without')
    }

    // ── Pass 2: Parallel Translation ────────────────────────────────────
    await drizzleDb
      .update(documents)
      .set({ status: 'translating', updatedAt: new Date() })
      .where(eq(documents.id, documentId))

    const ext = doc.format === 'docx' ? '.docx' : doc.format === 'pdf' ? '.pdf' : '.md'
    const outputDir = path.join(config.fileStoragePath, 'output')
    await fs.mkdir(outputDir, { recursive: true })
    const outputFile = path.join(outputDir, `${documentId}${ext}`)

    const writer = new StreamingOutputWriter(outputFile, doc.format, {
      title: doc.originalName.replace(/\.[^.]+$/, ''),
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
    }, OUTPUT_FLUSH_EVERY)
    await writer.init()

    let completedCount = 0
    let failedCount = 0
    let totalCost = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let authFailed = false
    const translateStart = Date.now()
    const totalChunks = plannedChunks.length

    // Sync progress to DB (called after each chunk completes)
    const syncProgress = async () => {
      await drizzleDb
        .update(documents)
        .set({
          completedChunks: completedCount,
          totalCostUsd: String(totalCost),
          totalInputTokens,
          totalOutputTokens,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
    }

    // Translate one chunk — called by the worker pool
    const translateOne = async (chunkIndex: number) => {
      if (authFailed) return

      const chunk = plannedChunks[chunkIndex]
      const previousContext = chunkIndex > 0 ? plannedChunks[chunkIndex - 1].text.slice(-120) : ''

      const result = await this.finalizeAndTranslateChunk(
        drizzleDb, documentId, chunkIndex, chunk.text, chunk.blocks,
        sourceLang, targetLang, previousContext, writer,
      )

      if (result === 'AUTH_FAILED') {
        authFailed = true
        return
      }

      if (result === 'ok' || result === 'cached' || result === 'skipped') {
        completedCount++
        const stats = await this.getChunkStats(drizzleDb, documentId, chunkIndex)
        if (stats) {
          totalCost += stats.cost
          totalInputTokens += stats.inputTokens
          totalOutputTokens += stats.outputTokens
        }
      } else {
        failedCount++
      }

      await this.updateBlockProgress(drizzleDb, documentId, chunk.lastBlockIndex)
      await syncProgress()
    }

    // Worker pool: translate up to TRANSLATION_CONCURRENCY chunks at a time
    const TRANSLATION_CONCURRENCY = 4
    let nextIdx = 0

    const worker = async () => {
      while (!authFailed) {
        const idx = nextIdx++
        if (idx >= totalChunks) break
        try {
          await translateOne(idx)
        } catch (err) {
          log.error({ documentId, chunkIndex: idx, err: (err as Error).message }, 'chunk worker error')
          failedCount++
          await syncProgress()
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(TRANSLATION_CONCURRENCY, totalChunks) }, () => worker()),
    )

    if (authFailed) {
      await writer.close()
      return
    }

    // ── Finalize ────────────────────────────────────────────────────────
    const translateDurationMs = Date.now() - translateStart

    if (failedCount > 0 && totalChunks > 0 && failedCount / totalChunks > 0.3) {
      await writer.close()
      const totalDurationMs = Date.now() - startedAt.getTime()
      await drizzleDb
        .update(documents)
        .set({
          status: 'failed',
          errorCode: 'TRANSLATION_FAILED',
          errorMessage: `${failedCount} of ${totalChunks} chunks failed`,
          totalChunks, translateDurationMs, totalDurationMs,
          completedAt: new Date(), updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
      return
    }

    await drizzleDb
      .update(documents)
      .set({ status: 'assembling', translateDurationMs, updatedAt: new Date() })
      .where(eq(documents.id, documentId))

    let assembleDurationMs = 0
    try {
      const assembleStart = Date.now()
      await writer.close()
      assembleDurationMs = Date.now() - assembleStart
    } catch (err) {
      log.error({ documentId, err: (err as Error).message }, 'output finalization failed')
    }

    const totalDurationMs = Date.now() - startedAt.getTime()
    await drizzleDb
      .update(documents)
      .set({
        status: 'completed',
        outputPath: outputFile,
        totalChunks,
        completedChunks: completedCount,
        totalCostUsd: String(totalCost),
        totalInputTokens, totalOutputTokens,
        translateDurationMs, assembleDurationMs, totalDurationMs,
        completedAt: new Date(), updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))

    log.info({
      documentId, completedCount, failedCount, totalChunks,
      totalCost, translateDurationMs, assembleDurationMs, totalDurationMs,
    }, 'translation job completed')
  }

  /**
   * Insert chunk to DB, translate via TranslationAgent, write to streaming output.
   * Returns: 'ok' | 'cached' | 'skipped' | 'failed' | 'AUTH_FAILED'
   */
  private async finalizeAndTranslateChunk(
    drizzleDb: any,
    documentId: string,
    chunkIndex: number,
    text: string,
    blocks: ContentBlock[],
    sourceLang: string,
    targetLang: string,
    previousContext: string,
    writer: StreamingOutputWriter,
  ): Promise<'ok' | 'cached' | 'skipped' | 'failed' | 'AUTH_FAILED'> {
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${documentId}:${chunkIndex}:${text.slice(0, 100)}`)
      .digest('hex')
      .slice(0, 64)

    const metadata = {
      hasTable: blocks.some((b) => b.type === 'table'),
      hasCode: blocks.some((b) => b.type === 'code'),
      blockTypes: [...new Set(blocks.map((b) => b.type))],
    }

    // Insert chunk to DB (idempotent)
    await drizzleDb.insert(translationChunks).values({
      documentId,
      chunkIndex,
      sourceText: text,
      status: 'pending',
      idempotencyKey,
      contextBefore: previousContext || null,
      metadata,
    }).onConflictDoNothing()

    // Check if already completed (crash recovery)
    const [existing] = await drizzleDb
      .select()
      .from(translationChunks)
      .where(and(
        eq(translationChunks.documentId, documentId),
        eq(translationChunks.chunkIndex, chunkIndex),
      ))

    if (existing?.status === 'completed' && existing.translatedText) {
      await writer.addChunk(chunkIndex, existing.translatedText, metadata)
      return 'skipped'
    }

    // Acquire advisory lock
    const lockQueryResult = await drizzleDb.execute(
      sql`SELECT pg_try_advisory_lock(hashtext(${idempotencyKey})) as locked`,
    ) as any
    const lockResult = lockQueryResult?.rows?.[0] ?? lockQueryResult?.[0]
    const gotLock = lockResult?.locked === true

    if (!gotLock) {
      log.debug({ documentId, chunkIndex }, 'advisory lock held — skipping')
      return 'skipped'
    }

    try {
      await drizzleDb
        .update(translationChunks)
        .set({ status: 'translating' })
        .where(and(
          eq(translationChunks.documentId, documentId),
          eq(translationChunks.chunkIndex, chunkIndex),
        ))

      // Translate via the unified TranslationAgent (phase 2)
      const result = await this.translateChunkWithRetry(
        text, sourceLang, targetLang, documentId, chunkIndex,
        previousContext, metadata.hasTable,
      )

      await drizzleDb
        .update(translationChunks)
        .set({
          translatedText: result.translatedText,
          status: 'completed',
          tokenCountInput: result.inputTokens,
          tokenCountOutput: result.outputTokens,
          costUsd: String(result.costUsd),
          completedAt: new Date(),
        })
        .where(and(
          eq(translationChunks.documentId, documentId),
          eq(translationChunks.chunkIndex, chunkIndex),
        ))

      // Write to streaming output immediately
      await writer.addChunk(chunkIndex, result.translatedText, metadata)

      log.info({ documentId, chunkIndex, costUsd: result.costUsd, fromCache: result.fromCache }, 'chunk translated and written')
      return result.fromCache ? 'cached' : 'ok'

    } catch (err) {
      const error = err as Error & { code?: string }

      if (error.code === 'AUTH_FAILED') {
        await drizzleDb
          .update(documents)
          .set({ status: 'failed', errorCode: 'AUTH_FAILED', errorMessage: error.message, updatedAt: new Date() })
          .where(eq(documents.id, documentId))
        return 'AUTH_FAILED'
      }

      if (error.code === 'CONTENT_FILTERED') {
        await drizzleDb
          .update(translationChunks)
          .set({ status: 'skipped', errorMessage: error.message })
          .where(and(
            eq(translationChunks.documentId, documentId),
            eq(translationChunks.chunkIndex, chunkIndex),
          ))
        return 'skipped'
      }

      await drizzleDb
        .update(translationChunks)
        .set({ status: 'failed', errorMessage: error.message, retryCount: MAX_RETRIES })
        .where(and(
          eq(translationChunks.documentId, documentId),
          eq(translationChunks.chunkIndex, chunkIndex),
        ))

      log.error({ documentId, chunkIndex, code: error.code, err: error.message }, 'chunk failed')
      return 'failed'

    } finally {
      await drizzleDb.execute(
        sql`SELECT pg_advisory_unlock(hashtext(${idempotencyKey}))`,
      )
    }
  }

  private async updateBlockProgress(drizzleDb: any, documentId: string, blockIndex: number): Promise<void> {
    if (blockIndex < 0) return
    await drizzleDb
      .update(documents)
      .set({ lastBlockIndex: blockIndex, updatedAt: new Date() })
      .where(eq(documents.id, documentId))
  }

  private async getChunkStats(drizzleDb: any, documentId: string, chunkIndex: number) {
    const [chunk] = await drizzleDb
      .select()
      .from(translationChunks)
      .where(and(
        eq(translationChunks.documentId, documentId),
        eq(translationChunks.chunkIndex, chunkIndex),
      ))
    if (!chunk || chunk.status !== 'completed') return null
    return {
      cost: chunk.costUsd ? parseFloat(chunk.costUsd) : 0,
      inputTokens: chunk.tokenCountInput || 0,
      outputTokens: chunk.tokenCountOutput || 0,
      translatedText: chunk.translatedText,
    }
  }

  private async translateChunkWithRetry(
    text: string,
    sourceLang: string,
    targetLang: string,
    documentId: string,
    chunkIndex: number,
    previousContext: string,
    hasTable: boolean,
  ) {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.translationAgent.translateChunk(
          text, sourceLang, targetLang, documentId, chunkIndex, previousContext, hasTable,
        )
      } catch (err) {
        lastError = err as Error & { code?: string }
        const code = (lastError as any).code

        if (!RETRIABLE_CODES.has(code)) throw lastError

        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt)
        log.warn({ attempt: attempt + 1, code, delayMs: delay }, 'retrying translation')
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw lastError!
  }
}
