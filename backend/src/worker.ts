import 'reflect-metadata'
import { initSentry, captureTranslationError } from './lib/sentry'
initSentry('worker')

import { NestFactory } from '@nestjs/core'
import { Worker, Job } from 'bullmq'
import { sql } from 'drizzle-orm'
import { AppModule } from './app.module'
import { TranslationJobProcessor } from './jobs/translation-job.processor'
import { QueueService } from './jobs/queue.service'
import { RedisService } from './redis/redis.service'
import { DatabaseService } from './database/database.service'
import { config } from './lib/config'
import { createChildLogger } from './lib/logger'
import { runMigrations } from './db/migrate'
import type { TranslationJobData } from './jobs/queue.service'

const log = createChildLogger('worker')

/**
 * Re-queue documents stuck in intermediate states after a crash/restart.
 * Runs once on worker startup — provides instant recovery instead of
 * waiting for BullMQ's passive stalled detection.
 */
async function resumeOrphanedDocuments(
  dbService: DatabaseService,
  queueService: QueueService,
): Promise<void> {
  const drizzleDb = dbService.getDb()
  const result = await drizzleDb.execute(
    sql`SELECT id, status FROM documents
        WHERE status IN ('uploaded', 'analyzing', 'translating', 'assembling')
        ORDER BY created_at ASC`,
  ) as any
  const rows: Array<{ id: string; status: string }> = result?.rows ?? result ?? []

  if (rows.length === 0) return

  log.info({ count: rows.length }, 'found orphaned documents — re-queuing')

  for (const row of rows) {
    try {
      const jobId = await queueService.addTranslationJob(row.id)
      log.info({ documentId: row.id, previousStatus: row.status, jobId }, 'orphaned document re-queued')
    } catch (err) {
      log.error({ documentId: row.id, err: (err as Error).message }, 'failed to re-queue orphaned document')
    }
  }
}

async function start(): Promise<void> {
  await runMigrations()

  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  })

  const processor = appContext.get(TranslationJobProcessor)
  const queueService = appContext.get(QueueService)
  const dbService = appContext.get(DatabaseService)
  const redisService = appContext.get(RedisService)
  const connection = redisService.getClient()

  // Proactive recovery: re-queue any documents stuck in intermediate states
  await resumeOrphanedDocuments(dbService, queueService)

  const worker = new Worker<TranslationJobData>(
    'translation',
    async (job: Job<TranslationJobData>) => {
      await processor.process(job)
    },
    {
      connection,
      concurrency: config.workerConcurrency,
      // Tighter stalled detection for faster crash recovery.
      // Worst-case passive recovery: lockDuration + stalledInterval = 45s.
      // But proactive recovery (above) makes this the fallback, not the primary.
      stalledInterval: 15_000,   // check for stalled jobs every 15s
      lockDuration: 30_000,      // job lock expires after 30s of no heartbeat
      lockRenewTime: 10_000,     // renew lock every 10s while job is active
    },
  )

  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'job completed')
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'job failed')
    captureTranslationError(err, {
      documentId: job?.data?.documentId,
      phase: 'translate',
      jobId: job?.id,
    })
  })

  worker.on('stalled', (jobId) => {
    log.warn({ jobId }, 'job stalled — BullMQ will auto-retry')
  })

  log.info({ concurrency: config.workerConcurrency }, 'translation worker started')

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received')
    await worker.close()
    await appContext.close()
    log.info('worker shut down cleanly')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  log.error({ err: err.message }, 'failed to start worker')
  process.exit(1)
})
