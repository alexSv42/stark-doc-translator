import { pgTable, uuid, varchar, text, integer, bigint, numeric, timestamp, jsonb, unique } from 'drizzle-orm/pg-core'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalName: varchar('original_name', { length: 500 }).notNull(),
  storagePath: varchar('storage_path', { length: 1000 }).notNull(),
  outputPath: varchar('output_path', { length: 1000 }),
  format: varchar('format', { length: 20 }).notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
  pageCount: integer('page_count'),
  status: varchar('status', { length: 30 }).notNull().default('uploaded'),
  sourceLanguage: varchar('source_language', { length: 10 }),
  targetLanguage: varchar('target_language', { length: 10 }).notNull(),
  errorCode: varchar('error_code', { length: 50 }),
  errorMessage: text('error_message'),
  totalChunks: integer('total_chunks'),
  completedChunks: integer('completed_chunks').default(0),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 6 }).default('0'),
  totalInputTokens: integer('total_input_tokens').default(0),
  totalOutputTokens: integer('total_output_tokens').default(0),
  qualityScore: numeric('quality_score', { precision: 4, scale: 3 }),
  parseDurationMs: integer('parse_duration_ms'),
  translateDurationMs: integer('translate_duration_ms'),
  lastBlockIndex: integer('last_block_index').default(-1),
  assembleDurationMs: integer('assemble_duration_ms'),
  totalDurationMs: integer('total_duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const translationChunks = pgTable('translation_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  sourceText: text('source_text').notNull(),
  translatedText: text('translated_text'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  idempotencyKey: varchar('idempotency_key', { length: 100 }).unique(),
  tokenCountInput: integer('token_count_input'),
  tokenCountOutput: integer('token_count_output'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  contextBefore: text('context_before'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  unique('unique_document_chunk').on(table.documentId, table.chunkIndex),
])

export const glossaries = pgTable('glossaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  sourceLanguage: varchar('source_language', { length: 10 }).notNull(),
  targetLanguage: varchar('target_language', { length: 10 }).notNull(),
  terms: jsonb('terms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const translationCache = pgTable('translation_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  sourceLanguage: varchar('source_language', { length: 10 }).notNull(),
  targetLanguage: varchar('target_language', { length: 10 }).notNull(),
  sourceText: text('source_text').notNull(),
  translatedText: text('translated_text').notNull(),
  modelUsed: varchar('model_used', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('unique_cache_entry').on(table.contentHash, table.sourceLanguage, table.targetLanguage),
])
