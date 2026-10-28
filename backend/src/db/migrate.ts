import pg from 'pg'
import { createChildLogger } from '../lib/logger'
import { config } from '../lib/config'

const log = createChildLogger('migrate')

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name   VARCHAR(500) NOT NULL,
  storage_path    VARCHAR(1000) NOT NULL,
  output_path     VARCHAR(1000),
  format          VARCHAR(20) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  page_count      INTEGER,
  status          VARCHAR(30) NOT NULL DEFAULT 'uploaded',
  source_language VARCHAR(10),
  target_language VARCHAR(10) NOT NULL,
  error_code      VARCHAR(50),
  error_message   TEXT,
  total_chunks    INTEGER,
  completed_chunks INTEGER DEFAULT 0,
  total_cost_usd  NUMERIC(10,6) DEFAULT 0,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  quality_score       NUMERIC(4,3),
  parse_duration_ms   INTEGER,
  translate_duration_ms INTEGER,
  last_block_index      INTEGER DEFAULT -1,
  assemble_duration_ms  INTEGER,
  total_duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS translation_chunks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index      INTEGER NOT NULL,
  source_text      TEXT NOT NULL,
  translated_text  TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  idempotency_key  VARCHAR(100) UNIQUE,
  token_count_input  INTEGER,
  token_count_output INTEGER,
  cost_usd         NUMERIC(10,6),
  retry_count      INTEGER DEFAULT 0,
  error_message    TEXT,
  context_before   TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  UNIQUE(document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS glossaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  terms           JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns that may be missing from earlier schema versions
DO $$ BEGIN
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_block_index INTEGER DEFAULT -1;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS translation_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash    VARCHAR(64) NOT NULL,
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  source_text     TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  model_used      VARCHAR(50) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(content_hash, source_language, target_language)
);
`

export async function runMigrations(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl })
  try {
    await client.connect()
    log.info('running migrations')
    await client.query(MIGRATION_SQL)
    log.info('migrations complete')
  } finally {
    await client.end()
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err: err.message }, 'migration failed')
      process.exit(1)
    })
}
