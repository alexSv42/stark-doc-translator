# SPEC.md — Stark Document Translator

## Product Definition

**Who this is for:** Engineering and ops teams at companies that receive contracts, technical specs, compliance documents, or vendor reports in foreign languages and need them translated fast — without uploading sensitive files to a third-party SaaS. Self-hosted, runs on their infra, their API key, their data never leaves their network.

**What it does:** Upload a PDF, DOCX, or Markdown file → pick a target language → get back a translated file in the same format. Real-time progress. Survives container crashes. Also works headless via MCP from Cursor or Claude Code.

**What it does NOT do:** OCR scanned documents, translate images, handle RTL layout, support offline/local models, or provide human-review workflows. These are documented scope cuts in DECISIONS.md.

---

## My Three Acceptance Criteria

These are mine — not from the assessment. Things I believe matter for this to be a product someone would actually use.

### 1. Translations survive interruptions

Kill the worker container mid-translation, restart it, and the document completes — no chunks re-translated, no data lost, no cost doubled. The user doesn't even notice.

**How it's verified:**
- Integration test: start translation → kill worker → restart → assert completion with no duplicate chunk indices and cost unchanged
- Manual test: `docker compose restart worker` during a real 20-page translation → observe it resume in the frontend
- DB check: `SELECT COUNT(*) FROM translation_chunks WHERE document_id = X GROUP BY chunk_index HAVING COUNT(*) > 1` returns 0 rows

### 2. Multiple users can work concurrently

Two users upload two different documents at the same time. Both translations progress independently. Neither blocks, starves, or corrupts the other. Two users uploading the *same* document don't cause a race condition.

**How it's verified:**
- Integration test: submit 3 documents simultaneously with MockProvider → all 3 complete, no interleaved chunks, no advisory lock deadlocks
- BullMQ concurrency = 3 means 3 jobs process in parallel within one worker
- PostgreSQL advisory locks prevent two workers from grabbing the same chunk — tested explicitly
- Each document has its own SSE channel (`document:{id}:progress`) — no cross-talk

### 3. Users understand and control ongoing work

At every moment the user knows: what stage the translation is in (glossary → translating → assembling), what percentage is done, what it's costing them so far, and if something went wrong — exactly what happened and what to do about it. They can cancel. They can refresh the page and pick up where they left off.

**How it's verified:**
- SSE events include: `stage`, `progress` (0–100), `completedChunks/totalChunks`, `costSoFar`, and on failure: `errorCode` + `errorMessage`
- Frontend shows all of these in the TranslationCard — no spinners with no context
- Page refresh mid-translation → SSE reconnects, current progress displays immediately (backend sends current state on SSE connect)
- Every error code has a user-facing message (see Appendix: Complete Error Code Reference) — never "Something went wrong"
- Cancel button on active translations → sets document status to `failed` with `error_code = 'CANCELLED'`
- Quality score (BT-Score) is displayed on the completed translation card so users can see how reliable the translation is

---

## Translation Quality Metric

**Metric: Back-translation consistency score (BT-Score)**

```
1. Take 10 representative paragraphs from a test document
2. Translate source → target (forward)
3. Translate target → source (back-translation)
4. BT-Score = average word-overlap ratio between original and back-translated text
```

Interpretation: >0.75 = strong meaning preservation, 0.50–0.75 = acceptable, <0.50 = drift.

This is crude and honest. It catches gross errors (hallucination, omission, garbled output) even though it can't catch subtle nuance loss. Measured on English→Spanish with a 5-page test document, reported in DECISIONS.md with the actual number.

---

## Deliberate Scope Cuts

| Cut | Why |
|-----|-----|
| OCR for scanned PDFs | Tesseract.js adds ~200MB to Docker image and 5–10s/page. Detect and reject with a clear message instead. |
| Image text translation | GPT-4o Vision is $0.01–0.03/image, adds complexity for a feature most assessment documents won't exercise. Copy images as-is in output. |
| RTL text layout (Arabic, Hebrew) | Bidi layout in pdf-lib requires significant effort. Support the translation text, but don't guarantee correct RTL rendering in output PDF. |
| Full PDF layout preservation | PDFs are drawing instructions. Attempting pixel-perfect reconstruction is a rabbit hole. Produce a clean, readable output PDF with the translated text. Good enough. |
| Quality validation agent | A second LLM call per chunk to rate quality doubles cost and time. Use the BT-Score metric on test docs instead. |
| Multi-worker horizontal scaling | One worker with concurrency=3 via BullMQ is sufficient. Advisory locks still protect against future multi-worker setups. |
| Batch API | 50% cheaper but async (up to 24h). Not compatible with real-time progress UX. |
| Authentication/RBAC | Self-hosted tool. Network boundary is the security boundary. Add auth later. |

---

## Reviewer Questions — Design Answers

These are the hard questions the assessment evaluates. Each has a concrete answer baked into the implementation.

### 1. How do you translate a document that doesn't fit in one context window and keep it coherent across the seams?

**Answer: Semantic chunking by paragraphs, never by token count alone.**

The chunker doesn't blindly split at N tokens. It parses the document into semantic units first — paragraphs, headings, tables, list items — then groups those units into chunks that fit the context window. The hierarchy:

```
Document → Pages → Blocks (heading | paragraph | table | list | code) → Sentences
```

Chunking priority:
1. Try to split between paragraphs (natural semantic boundary)
2. If a single paragraph exceeds the limit, split between sentences
3. Never split mid-sentence under any circumstance
4. A heading always stays glued to the paragraph after it
5. A table stays in one chunk (if it fits); if a table exceeds the limit, it gets its own chunk

Coherence across seams:
- **Context carry:** The last 3 translated sentences from chunk N are injected into chunk N+1's prompt as "For context, the previous chunk ended with: ..."
- **Glossary injection:** The GlossaryAgent extracts terminology once upfront. Every chunk sees the same glossary in its system prompt, so "Controller" is always "Controlador" — not "Regulador" in chunk 50.
- **Overlap is prompt-only:** The overlap text is NOT part of the translatable content (that would create duplicates in output). It's injected into the prompt purely for context.

This is testable: the chunker test suite includes a known multi-paragraph text and verifies no chunk boundary falls inside a sentence.

### 2. How do you make it fast? What did you measure before and after?

**Answer: Measure file weight, chunk count, and time-per-chunk. Optimize the bottleneck.**

Performance metrics to capture on every translation (stored in logs and DB):

| Metric | Where Measured | Why |
|--------|---------------|-----|
| `file_size_bytes` | Upload | Correlate file size to total duration |
| `page_count` | Parsing | Pages → chunks → time predictor |
| `total_chunks` | Chunking | Direct input to total duration |
| `parse_duration_ms` | Parser | Is parsing the bottleneck or translation? |
| `chunk_translate_duration_ms` | Per chunk | Average time per OpenAI call |
| `assembly_duration_ms` | Output gen | Is PDF generation slow? |
| `total_duration_ms` | End-to-end | Upload-to-download wall time |
| `tokens_per_second` | Per chunk | Track OpenAI throughput over time |

**What dominates:** Translation API calls. Parsing a 50-page PDF takes ~2 seconds. Generating output takes ~1 second. Translating 30 chunks at ~2–4 seconds each takes 60–120 seconds. The API calls are 95%+ of total time.

**Speed levers (in priority order):**
1. **Translation cache** — same content skips the API entirely. Second translation of same doc: ~0 seconds.
2. **Chunk size tuning** — bigger chunks = fewer API calls = faster. But too big risks context overflow. Sweet spot: 2000–3500 tokens.
3. **Sequential with context** vs **parallel without context** — we chose sequential for coherence. This is a conscious trade-off: ~2× slower but coherent output. Document this in DECISIONS.md.

**Benchmark to run and report:**

```
| Document          | Pages | Chunks | Parse (ms) | Translate (ms) | Assemble (ms) | Total (s) |
|-------------------|-------|--------|------------|----------------|---------------|-----------|
| sample-5page.pdf  | 5     | ~4     | ...        | ...            | ...           | ...       |
| sample-20page.pdf | 20    | ~12    | ...        | ...            | ...           | ...       |
| sample-5page (cached) | 5 | ~4    | ...        | 0              | ...           | ...       |
```

Fill this table with real numbers during Phase 8 and report in DECISIONS.md.

### 3. Where does an agent earn its keep, and where is it just an expensive `if`?

**Answer: GlossaryAgent = real agent. Translation = plain completion. Don't agent everything.**

| Pipeline Stage | Agent or Completion? | Why |
|---------------|---------------------|-----|
| Glossary extraction | **Agent** (openai-agents + tools) | Multi-step reasoning: read sample → decide which terms matter → search cache → decide whether to use/override cached → save. This is a loop with judgment calls between tool invocations. A plain completion can't search the DB or save entries. |
| Chunk translation | **Plain completion** | Input → output. No tools needed. The prompt has everything (glossary, context, instructions). Using an agent here would add tool-calling overhead × N chunks for zero benefit. |
| Language detection | **Plain completion** (or heuristic) | Classification task. One call, one answer. An agent would be an expensive `if`. |
| Output generation | **No AI at all** | Deterministic string assembly. AI has nothing to add. |

The GlossaryAgent earns its place because removing the tools and replacing with a single completion would mean: (a) no cache lookups — terminology would be inconsistent with past translations, (b) no persistence — the glossary wouldn't be saved for future documents, (c) no iteration — the agent sometimes finds more terms on a second pass after seeing what the cache returns.

### 4. What belongs in your MCP tool surface, and what doesn't?

**Answer: User intents, not API endpoints.**

**Included — maps to what a developer in Cursor actually thinks:**
| Tool | User Intent |
|------|------------|
| `translate_document` | "Translate this file for me" |
| `get_translation_status` | "Is it done yet?" |
| `download_translation` | "Give me the result" |
| `list_supported_languages` | "What languages can I use?" |
| `get_document_cost` | "How much did that cost?" |

**Excluded — implementation details, not user actions:**
| Not a Tool | Why |
|-----------|-----|
| `health_check` | Developer doesn't care — if it's broken, the other tools will error. |
| `get_chunks` | Internal state. User wants the translated file, not chunk #7. |
| `create_document` + `start_translation` (two-step) | User thinks "translate this file" as one action, not upload-then-trigger. |
| `get_glossary` | Internal optimization detail. |
| `delete_document` | Cleanup — do it from the web UI or DB, not from an AI chat. |

### 5. How would you add a new file format in 10 minutes? Your second format is the evidence.

**Answer: Parser and OutputGenerator are interfaces with a registry. Adding a format = one file each.**

```typescript
// Adding a new format (e.g., HTML) requires:
// 1. backend/src/parsers/html-parser.ts   — implements FormatParser
// 2. backend/src/output/html-output.ts    — implements OutputGenerator
// 3. Register both in their respective registries
// 4. Add 'html' to SupportedFormat type
// That's it. No changes to translation pipeline, worker, MCP, or frontend logic.
```

The proof: DOCX is the second format. The pipeline doesn't know or care what format it's translating — it sees `ParsedDocument` (text + pages + metadata) and `Chunk[]`. Format-specific logic is isolated in parsers and output generators. Markdown is the third format — even simpler.

**FormatParser interface:**
```typescript
interface FormatParser {
  readonly supportedFormats: string[]
  canParse(format: string): boolean
  parse(filePath: string): Promise<ParsedDocument>
}
```

**OutputGenerator interface:**
```typescript
interface OutputGenerator {
  readonly supportedFormats: string[]
  canGenerate(format: string): boolean
  generate(chunks: TranslatedChunk[], metadata: DocumentMetadata, outputPath: string): Promise<void>
}
```

Both use a registry pattern:
```typescript
const parsers: FormatParser[] = [new PdfParser(), new DocxParser(), new MarkdownParser()]
function getParser(format: string): FormatParser {
  const parser = parsers.find(p => p.canParse(format))
  if (!parser) throw new AppError('UNSUPPORTED_FORMAT', 415, `'${format}' is not supported.`)
  return parser
}
```

### 6. What happens when a user uploads an unsupported, corrupted, or enormous file?

**Answer: Dual validation — frontend rejects early, backend validates authoritatively.**

Validation happens at two layers. The frontend provides instant feedback. The backend is the authority.

**Frontend checks (instant, before upload starts):**
| Check | Implementation | User sees |
|-------|---------------|-----------|
| File extension | `react-dropzone` accept list: `.pdf`, `.docx`, `.md` | Drop zone rejects with "Unsupported file type" |
| File size | `react-dropzone` maxSize: 100 MB | "File is too large (max 100 MB)" |
| Empty file | Check `file.size === 0` | "File is empty" |

**Backend checks (authoritative, after upload):**
| Check | Implementation | Error Code |
|-------|---------------|-----------|
| File size re-check | `multer` limits + stat after save | `FILE_TOO_LARGE` |
| Extension whitelist | Route handler checks extension | `UNSUPPORTED_FORMAT` |
| Magic bytes | Read first 4 bytes: `%PDF` / `PK` | `SECURITY_VIOLATION` |
| Zip bomb (DOCX) | Compare compressed vs decompressed size | `SECURITY_VIOLATION` |
| Corrupt file | Parser try/catch | `CORRUPT_FILE` |
| Password-protected | pdf-parse error detection | `PASSWORD_PROTECTED` |
| Scanned/image-only | Avg chars per page < 100 | `SCANNED_PDF_DETECTED` |
| Too many pages | page count > 500 | `DOCUMENT_TOO_LONG` |
| No extractable text | Total text length < 10 chars | `NO_EXTRACTABLE_TEXT` |
| Parse timeout | 60-second AbortController | `PARSE_TIMEOUT` |

**Why both layers:** Frontend validation prevents wasted bandwidth (don't upload 200 MB only to be rejected). Backend validation prevents bypass (curl, MCP, malformed clients). Never trust the client.

### 7. What does one translated document cost, and what dominates that cost?

**Answer: Track per-chunk, sum per-document. Translation API calls dominate at >98%.**

**Cost model (gpt-4o-mini pricing, October 2026):**

```
Input:  $0.15 / 1M tokens
Output: $0.60 / 1M tokens

Typical 5-page document:
  ~8,000 tokens input × $0.15/1M  = $0.0012
  ~8,000 tokens output × $0.60/1M = $0.0048
  Glossary agent: ~2,000 tokens   = $0.0004
  ──────────────────────────────────────────
  Total: ~$0.006 per 5-page doc

Typical 50-page document:
  ~80,000 tokens input             = $0.012
  ~80,000 tokens output            = $0.048
  Glossary agent: ~2,000 tokens    = $0.0004
  ──────────────────────────────────────────
  Total: ~$0.06 per 50-page doc
```

**What dominates:**
- **Output tokens: ~80% of cost.** Output pricing is 4× input pricing. The translated text IS the output.
- **Glossary agent: <1% of cost.** Runs once per document regardless of size.
- **Parsing, chunking, PDF generation: $0.** No API calls.
- **Cache hits: $0.** Same paragraph translated twice costs nothing the second time.

**How we track it:**
- Every OpenAI call returns `usage.prompt_tokens` and `usage.completion_tokens`
- We compute `cost_usd = (input_tokens × input_price + output_tokens × output_price)` immediately
- Stored per chunk in `translation_chunks.cost_usd`
- Summed on `documents.total_cost_usd` after each chunk completes
- Exposed via `GET /api/stats` and `GET /api/documents/:id/status` (includes `cost` field)
- MCP tool `get_document_cost` returns the breakdown

**Cost optimization already built in:**
1. Translation cache — same content = $0 on repeat
2. gpt-4o-mini over gpt-4o — 10× cheaper, good enough for translation
3. Glossary agent runs once, not per-chunk — saves ~$0.0004 × N chunks

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  docker compose                                         │
│                                                         │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐          │
│  │ frontend │──▶│  api      │──▶│  worker   │          │
│  │ :3000    │   │  :4000    │   │  (BullMQ) │          │
│  └──────────┘   └─────┬─────┘   └─────┬─────┘          │
│                       │               │                 │
│                  ┌────┴────┐     ┌────┴────┐           │
│                  │ core    │◀────│ OpenAI  │           │
│                  │ service │     │ + Agent │           │
│                  └────┬────┘     └─────────┘           │
│                       │                                 │
│  ┌──────────┐   ┌────┴─────┐   ┌──────────┐          │
│  │ mcp      │──▶│ postgres │   │  redis   │          │
│  │ (stdio)  │   │  :5432   │   │  :6379   │          │
│  └──────────┘   └──────────┘   └──────────┘          │
│                                                         │
│                 ┌──────────────┐                        │
│                 │ /app/data    │ (shared volume)        │
│                 └──────────────┘                        │
└─────────────────────────────────────────────────────────┘

Key: core service is shared by api, worker, AND mcp.
     Two front doors (REST + MCP) onto one core.
```

---

## Database Schema (PostgreSQL + Drizzle ORM)

```sql
-- documents: one row per uploaded file
CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name   VARCHAR(500) NOT NULL,
  storage_path    VARCHAR(1000) NOT NULL,
  output_path     VARCHAR(1000),
  format          VARCHAR(20) NOT NULL,       -- 'pdf' | 'docx' | 'md'
  file_size_bytes BIGINT NOT NULL,
  page_count      INTEGER,
  status          VARCHAR(30) NOT NULL DEFAULT 'uploaded',
    -- 'uploaded' | 'analyzing' | 'translating' | 'assembling' | 'completed' | 'failed'
  source_language VARCHAR(10),                -- auto-detected or user-provided
  target_language VARCHAR(10) NOT NULL,
  error_code      VARCHAR(50),
  error_message   TEXT,
  total_chunks    INTEGER,
  completed_chunks INTEGER DEFAULT 0,
  total_cost_usd  NUMERIC(10,6) DEFAULT 0,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  quality_score       NUMERIC(4,3),       -- BT-Score (0.000–1.000), measured after translation
  parse_duration_ms   INTEGER,            -- timing: how long parsing took
  translate_duration_ms INTEGER,          -- timing: how long all chunk translations took
  assemble_duration_ms  INTEGER,          -- timing: how long output generation took
  total_duration_ms     INTEGER,          -- timing: end-to-end wall time
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- translation_chunks: one row per chunk of a document
CREATE TABLE translation_chunks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index      INTEGER NOT NULL,
  source_text      TEXT NOT NULL,
  translated_text  TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- 'pending' | 'translating' | 'completed' | 'failed' | 'skipped'
  idempotency_key  VARCHAR(100) UNIQUE,
  token_count_input  INTEGER,
  token_count_output INTEGER,
  cost_usd         NUMERIC(10,6),
  retry_count      INTEGER DEFAULT 0,
  error_message    TEXT,
  context_before   TEXT,                      -- last 3 sentences of previous chunk translation
  metadata         JSONB,                     -- { pageNumbers, hasTable, hasImage }
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  UNIQUE(document_id, chunk_index)
);

-- glossaries: extracted terminology per document
CREATE TABLE glossaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  terms           JSONB NOT NULL,             -- [{ source, target, type }]
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- translation_cache: content-addressed cache across all documents
CREATE TABLE translation_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash    VARCHAR(64) NOT NULL,       -- SHA-256 of source text
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  source_text     TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  model_used      VARCHAR(50) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(content_hash, source_language, target_language)
);
```

---

## docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: stark_translator
      POSTGRES_USER: stark
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-stark_dev_password}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stark -d stark_translator"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redisdata:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "4000:4000"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://stark:${POSTGRES_PASSWORD:-stark_dev_password}@postgres:5432/stark_translator
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      FILE_STORAGE_PATH: /app/data/files
    volumes:
      - filedata:/app/data/files
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "dist/worker.js"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://stark:${POSTGRES_PASSWORD:-stark_dev_password}@postgres:5432/stark_translator
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      FILE_STORAGE_PATH: /app/data/files
    volumes:
      - filedata:/app/data/files
    restart: unless-stopped

  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    ports:
      - "3000:80"
    depends_on:
      - api

  mcp:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "dist/mcp-server.js"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      DATABASE_URL: postgresql://stark:${POSTGRES_PASSWORD:-stark_dev_password}@postgres:5432/stark_translator
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      FILE_STORAGE_PATH: /app/data/files
    volumes:
      - filedata:/app/data/files
    stdin_open: true
    profiles: ["mcp"]

volumes:
  pgdata:
  redisdata:
  filedata:
```

---

## Phase 1 — Scaffold, Database, Docker

### Goal
A running Docker Compose stack with NestJS API, Postgres, Redis, file upload, health checks, and structured logging. No AI. Just the foundation.

### Files to Create

```
backend/
├── package.json
├── tsconfig.json
├── nest-cli.json
├── Dockerfile
├── src/
│   ├── main.ts                — NestJS bootstrap, CORS, shutdown hooks
│   ├── app.module.ts          — Root module importing all feature modules
│   ├── worker.ts              — BullMQ worker entry (uses NestJS app context for DI)
│   ├── database/
│   │   ├── database.module.ts — @Global() module providing DatabaseService
│   │   └── database.service.ts— Drizzle + pg pool, ping, close
│   ├── redis/
│   │   ├── redis.module.ts    — @Global() module providing RedisService
│   │   └── redis.service.ts   — IORedis singleton, ping, close
│   ├── health/
│   │   ├── health.module.ts
│   │   └── health.controller.ts — GET /health
│   ├── documents/
│   │   ├── documents.module.ts
│   │   ├── documents.controller.ts — POST /api/documents/upload, GET /api/documents, etc.
│   │   └── documents.service.ts    — Upload, list, status, delete business logic
│   ├── common/
│   │   ├── filters/app-exception.filter.ts  — Maps AppError → HTTP JSON response
│   │   └── interceptors/correlation-id.interceptor.ts — AsyncLocalStorage correlation ID
│   ├── db/
│   │   ├── schema.ts          — Drizzle table definitions (all 4 tables)
│   │   └── migrate.ts         — Run migrations on startup
│   ├── lib/
│   │   ├── errors.ts          — AppError class extending NestJS HttpException
│   │   ├── logger.ts          — pino logger with correlation ID injection
│   │   ├── redis.ts           — Redis connection helpers (standalone use)
│   │   ├── security.ts        — Magic bytes + file size validation
│   │   └── config.ts          — env var parsing with defaults
│   ├── parsers/               — Phase 2: format-specific parsers
│   ├── chunker/               — Phase 2: semantic chunking engine
│   ├── translation/           — Phase 3: provider, cache, OpenAI/mock
│   ├── agents/                — Phase 3: GlossaryAgent with @openai/agents
│   ├── jobs/                  — Phase 3: BullMQ queue + job processor
│   ├── core/                  — Phase 3: TranslationService orchestrator
│   └── types/
│       └── index.ts           — Shared TypeScript types
Dockerfile.frontend            — nginx serving the built React app
```

### Key Types

```typescript
// lib/errors.ts
class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    public userMessage: string,
    public details?: Record<string, unknown>
  ) { super(userMessage) }
}

// types/index.ts
type DocumentStatus = 'uploaded' | 'analyzing' | 'translating' | 'assembling' | 'completed' | 'failed'
type ChunkStatus = 'pending' | 'translating' | 'completed' | 'failed' | 'skipped'
type SupportedFormat = 'pdf' | 'docx' | 'md'

interface DocumentRow {
  id: string
  originalName: string
  storagePath: string
  outputPath: string | null
  format: SupportedFormat
  fileSizeBytes: number
  pageCount: number | null
  status: DocumentStatus
  sourceLanguage: string | null
  targetLanguage: string
  errorCode: string | null
  errorMessage: string | null
  totalChunks: number | null
  completedChunks: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}
```

### Error Table — Phase 1

| Scenario | Code | HTTP | User Message |
|----------|------|------|--------------|
| No file in request | `NO_FILE_PROVIDED` | 400 | "No file was provided. Please select a file to upload." |
| File exceeds 100 MB | `FILE_TOO_LARGE` | 413 | "File exceeds the 100 MB limit." |
| Unsupported extension | `UNSUPPORTED_FORMAT` | 415 | "'.{ext}' is not supported. Accepted: PDF, DOCX, MD." |
| DB unreachable | `DB_CONNECTION_FAILED` | 503 | "Service temporarily unavailable." |
| Redis unreachable | `REDIS_CONNECTION_FAILED` | 503 | "Service temporarily unavailable." |
| Disk full | `STORAGE_FULL` | 507 | "Server storage is full." |

### Tests
- `health.test.ts` — GET /health returns 200 with db+redis status
- `upload.test.ts` — valid PDF upload returns 200 with document row; oversized file returns 413; .exe returns 415; no file returns 400

### Acceptance Criteria
- [ ] `docker compose up --build` starts all 5 services, no errors
- [ ] `GET /health` → `{ status: "ok", db: "connected", redis: "connected" }`
- [ ] `POST /api/documents/upload` with a PDF → file saved to volume, row in DB
- [ ] Upload a 150 MB file → 413 with clear message
- [ ] Upload a .exe → 415 with clear message
- [ ] Logs are structured JSON with correlation IDs
- [ ] `docker compose down && docker compose up` → Postgres data persists
- [ ] SIGTERM → graceful shutdown (drain, close pool, exit 0)

---

## Phase 2 — Document Parsing & Chunking

### Goal
Parse PDF/DOCX/MD into structured text blocks. Chunk them for translation. Detect bad files. Never OOM on huge documents.

### Files to Create

```
backend/src/
├── parsers/
│   ├── index.ts               — FormatParser interface + registry (getParser())
│   ├── pdf-parser.ts          — pdf-parse + scanned detection
│   ├── docx-parser.ts         — mammoth
│   └── markdown-parser.ts     — split by headings, preserve code blocks
├── chunker/
│   └── index.ts               — Semantic chunking engine
└── lib/
    └── security.ts            — Magic bytes check, zip bomb detection
```

**Format extensibility:** The parser registry is an array. Adding HTML support = write `html-parser.ts` implementing `FormatParser`, push it into the array. No other file changes. The pipeline only sees `ParsedDocument` — it doesn't know what format produced it. DOCX and Markdown prove this works: they share zero code with the PDF parser but produce the same `ParsedDocument` shape. This answers "how would you add a new format in 10 minutes?" — the second and third formats are the evidence.

### Key Types

```typescript
// parsers/index.ts
interface ParsedDocument {
  text: string
  pages: PageContent[]
  blocks: ContentBlock[]          // semantic blocks for the chunker
  metadata: DocumentMetadata
}

interface PageContent {
  pageNumber: number
  text: string
}

interface ContentBlock {
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'code' | 'image_placeholder'
  text: string
  pageNumber: number
  translatable: boolean           // false for code blocks
}

interface DocumentMetadata {
  pageCount: number
  estimatedTokens: number
  isScanned: boolean
  detectedLanguage: string | null
  parseDurationMs: number         // track for performance reporting
}

interface FormatParser {
  readonly supportedFormats: string[]
  canParse(format: string): boolean
  parse(filePath: string): Promise<ParsedDocument>
}

// chunker/index.ts
interface Chunk {
  index: number
  text: string
  pageNumbers: number[]
  metadata: { hasTable: boolean; hasCode: boolean; blockTypes: string[] }
  overlapBefore: string           // last ~150 tokens from previous chunk (prompt-only)
  translatable: boolean           // false if chunk is entirely code blocks
}
```

### Chunking Strategy — Semantic, Not Arbitrary

The chunker is **semantic-first**: it understands document structure before it counts tokens.

**Step 1 — Parse into semantic blocks:**
```
Document text → split into blocks:
  - Paragraphs (split on double-newline or blank line)
  - Headings (lines starting with # in markdown, or detected by parser)
  - Tables (lines containing | pipes, or detected table regions)
  - List items (lines starting with - * or 1.)
  - Code blocks (fenced ``` blocks — marked as non-translatable)
```

**Step 2 — Group blocks into chunks respecting boundaries:**
```
for each block:
  if (current_chunk + block) fits in 3500 tokens → add to current chunk
  if block alone exceeds 3500 tokens → split block at sentence boundaries
  if (current_chunk + block) exceeds limit → finalize current chunk, start new one
  
  Rules:
  - A heading ALWAYS stays with the next block (glued)
  - A table stays in one chunk (if it fits)
  - Never split mid-sentence
  - Minimum chunk: 100 tokens (merge with previous if smaller)
```

**Step 3 — Add context carry (prompt-only, not in translatable text):**
```
chunk[N+1].context_before = last 3 sentences of chunk[N]'s translated text
→ injected into prompt as: "For context, the previous chunk ended with: ..."
→ NOT included in the translatable text (avoids duplicates in output)
```

**Target chunk size:** 2000–3500 tokens. This fits comfortably in gpt-4o-mini's 128k context with the system prompt, glossary, and context overhead.

**Why semantic over fixed-size:** A 3000-token split that lands mid-sentence produces garbage translations. A paragraph boundary split at 2800 tokens produces clean translations. The 200-token "waste" is negligible compared to the quality gain.

### Scanned PDF Detection

```typescript
function isScanned(pages: PageContent[]): boolean {
  const avgCharsPerPage = pages.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0) / pages.length
  return avgCharsPerPage < 100
}
```

If detected: set `error_code = 'SCANNED_PDF_DETECTED'`, don't proceed.

### Security Checks (before parsing)
1. **Magic bytes:** PDF must start with `%PDF`, DOCX must start with `PK` (it's a ZIP).
2. **Zip bomb (DOCX):** If decompressed size > 50× compressed size, reject.
3. **File size on disk:** Re-verify after upload (defense in depth).
4. **Filename sanitization:** Strip `../`, null bytes, use UUID as storage filename.

### Error Table — Phase 2

| Scenario | Code | User Message |
|----------|------|--------------|
| Corrupt/unopenable file | `CORRUPT_FILE` | "This file is corrupted and cannot be opened." |
| Password-protected PDF | `PASSWORD_PROTECTED` | "This PDF is password-protected. Remove the password and re-upload." |
| Scanned/image-only PDF | `SCANNED_PDF_DETECTED` | "This PDF contains scanned images instead of extractable text." |
| No extractable text | `NO_EXTRACTABLE_TEXT` | "No text could be extracted from this file." |
| Exceeds 500 pages | `DOCUMENT_TOO_LONG` | "This document has {n} pages (limit: 500)." |
| Parse timeout (>60 s) | `PARSE_TIMEOUT` | "Parsing took too long. The file may be too complex." |
| Magic bytes mismatch | `SECURITY_VIOLATION` | "This file failed security validation." |
| Zip bomb detected | `SECURITY_VIOLATION` | "This file failed security validation." |

### Tests
- `chunker.test.ts` — 10-page text → correct chunk count; never splits mid-sentence; tables stay intact; heading stays with next paragraph; overlap is correct
- `pdf-parser.test.ts` — valid PDF extracts text; scanned PDF detected; corrupt PDF throws `CORRUPT_FILE`; password PDF throws `PASSWORD_PROTECTED`
- `docx-parser.test.ts` — extracts headings, lists, tables
- `markdown-parser.test.ts` — preserves code blocks (should not be translated), splits by headings
- `security.test.ts` — magic bytes pass/fail; zip bomb detection

### Acceptance Criteria
- [ ] A 5-page PDF → parsed → chunked → chunks stored in DB with correct metadata
- [ ] A corrupt PDF → specific error code `CORRUPT_FILE`, not a stack trace
- [ ] A scanned PDF → `SCANNED_PDF_DETECTED` with helpful message
- [ ] A 200-page PDF → parses without OOM (container memory < 512 MB)
- [ ] DOCX with tables → tables extracted, detected in chunk metadata
- [ ] Markdown code blocks are not marked for translation
- [ ] Idempotency keys are deterministic: same input → same key

---

## Phase 3 — Translation Pipeline & Agent

### Goal
The BullMQ worker translates chunks via OpenAI. A GlossaryAgent (using `openai-agents` with tool calling) extracts terminology before translation. Translation cache prevents double billing. Cost is tracked per chunk.

### Files to Create

```
backend/src/
├── translation/
│   ├── provider.ts            — TranslationProvider interface
│   ├── openai-provider.ts     — OpenAI implementation
│   ├── mock-provider.ts       — Mock for tests
│   └── cache.ts               — Translation cache (content-hash lookup)
├── agents/
│   └── glossary-agent.ts      — GlossaryAgent with openai-agents SDK
├── jobs/
│   ├── translation-job.ts     — The main translation job processor
│   └── queue.ts               — BullMQ queue setup
└── core/
    └── translation-service.ts — Orchestration: upload → parse → chunk → queue → assemble
```

### Key Types

```typescript
// translation/provider.ts
interface TranslationContext {
  glossary: { source: string; target: string; type: string }[]
  previousContext: string        // last 3 sentences of previous chunk translation
  documentTitle: string | null
  chunkIndex: number
  totalChunks: number
  hasTable: boolean
}

interface TranslationResult {
  translatedText: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  model: string
  durationMs: number
  fromCache: boolean
}

interface TranslationProvider {
  translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    context: TranslationContext
  ): Promise<TranslationResult>
}
```

### GlossaryAgent — Why the Agent Earns Its Place

Plain `chat.completions.create` can translate text — that's input→output, no tools needed.

Glossary extraction is different. The agent must:
1. Read a document sample and **decide** which terms are domain-specific (judgment, not rules)
2. Call `search_translation_cache` to check if we've seen those terms before
3. **Decide** whether to use cached translations or override based on this document's context
4. Call `save_glossary_entry` to persist each decision with reasoning

This is a genuine multi-step tool-calling loop with conditional logic between steps. A plain completion cannot do steps 2–4 because they require tool calls with decisions between them.

```typescript
// agents/glossary-agent.ts — pseudocode structure
import { Agent, tool, run } from '@openai/agents'

const searchCacheTool = tool({
  name: 'search_translation_cache',
  description: 'Look up existing translations for terms in the cache',
  parameters: { terms: z.array(z.string()) },
  execute: async ({ terms }) => {
    // query translation_cache for each term, return matches
  }
})

const saveGlossaryTool = tool({
  name: 'save_glossary_entry',
  description: 'Save a term translation to the glossary for this document',
  parameters: {
    source: z.string(),
    target: z.string(),
    type: z.enum(['brand', 'technical', 'proper_noun', 'domain_term', 'keep_original']),
    reasoning: z.string()
  },
  execute: async ({ source, target, type, reasoning }) => {
    // insert into glossaries table
  }
})

const glossaryAgent = new Agent({
  name: 'GlossaryAgent',
  model: 'gpt-4o-mini',
  instructions: `You extract domain-specific terminology from a document sample.
For each term: search the cache for existing translations, decide whether to use
or override them, then save your decision. 10-30 entries is typical. Skip common words.`,
  tools: [searchCacheTool, saveGlossaryTool],
})
```

### Translation Worker Flow

```
1. Job received (documentId)
2. Set document.status = 'translating', document.started_at = now()
3. Run GlossaryAgent on first ~5000 tokens of document
   → On failure: log warning, continue WITHOUT glossary (graceful degradation)
4. For each chunk WHERE status != 'completed':
   a. Check translation_cache by content_hash → if hit, use cached, skip API call
   b. Acquire advisory lock: SELECT pg_try_advisory_lock(hashtext(idempotency_key))
      → If lock fails: another worker has it, skip
   c. Set chunk.status = 'translating'
   d. Call TranslationProvider.translate() with glossary + context from previous chunk
   e. On success: set chunk.status = 'completed', store translated_text, update costs,
      insert into translation_cache, emit SSE progress
   f. On retriable failure (429, 500, 502, 503, timeout): retry with exponential backoff (max 3)
   g. On non-retriable failure: mark chunk 'failed', continue to next
   h. Release advisory lock
5. If all chunks completed → trigger output generation → set status = 'completed'
6. If >30% chunks failed → set status = 'failed' with summary
```

### Translation Prompt (per chunk)

```
SYSTEM: You are a professional document translator.
Translate from {sourceLang} to {targetLang}.

Rules:
- Translate all text accurately and naturally.
- Preserve markdown formatting (tables, lists, bold, headings).
- Do NOT translate: code blocks, URLs, email addresses, brand names marked "keep_original".
- Glossary (use these translations consistently):
  {glossary entries as "source → target" pairs}
- For context, the previous chunk ended with:
  "{previousContext}"
- This is chunk {index} of {total}.
{if hasTable: "- This chunk contains a markdown table. Translate cell contents but preserve table structure (pipes/dashes) exactly."}

USER: {chunk source text}
```

### Model Selection

| Task | Model | Reason |
|------|-------|--------|
| Glossary extraction | gpt-4o-mini | Tool-calling works fine on mini; save cost |
| Chunk translation | gpt-4o-mini | Bulk task, good quality, 10× cheaper than 4o |
| Back-translation (quality metric) | gpt-4o-mini | Measurement task only |

### Error Table — Phase 3

| Scenario | Code | Behavior |
|----------|------|----------|
| OpenAI 429 (rate limit) | `RATE_LIMITED` | Backoff: 1s → 2s → 4s → 8s → fail chunk |
| OpenAI 500/502/503 | `PROVIDER_ERROR` | Retry 3× with 2s delay. If all fail, mark chunk failed, continue. |
| OpenAI timeout (>120 s) | `PROVIDER_TIMEOUT` | Retry once. If still timeout, mark failed. |
| Context length exceeded | `CONTEXT_TOO_LONG` | Split chunk in half at sentence boundary, retry each half. |
| Content filter triggered | `CONTENT_FILTERED` | Mark chunk 'skipped'. Continue. |
| Invalid API key | `AUTH_FAILED` | Fail entire job immediately. Do not retry. |
| Glossary agent fails | `GLOSSARY_FAILED` | Log warning. Continue without glossary. |

### Tests
- `mock-provider.test.ts` — returns predictable translations
- `cache.test.ts` — cache hit returns text with costUsd=0; cache miss calls provider
- `translation-job.test.ts` — 3-chunk document completes end-to-end with MockProvider; failed chunk doesn't block others; context carry passes correct sentences
- `glossary-agent.test.ts` — agent calls tools in correct order (search → save)
- `cost-tracking.test.ts` — costs accumulate correctly on document row

### Acceptance Criteria
- [ ] A 5-page PDF translated end-to-end (upload → translate → chunks completed in DB)
- [ ] Glossary agent extracts terms — they appear in glossaries table and in chunk prompts
- [ ] Same document translated twice → second time instant, total_cost_usd = 0 for second run
- [ ] Cost tracked per chunk and summed on document
- [ ] Worker logs show structured JSON with document/chunk IDs
- [ ] `RATE_LIMITED` triggers backoff, not immediate failure

---

## Phase 4 — Crash Recovery & Idempotency

### Goal
Survive `docker compose restart worker` mid-translation. No duplicate chunks, no lost progress, no double billing.

### Files to Create/Modify

```
backend/src/
├── jobs/
│   └── recovery.ts            — recoverStaleJobs(), heartbeat, stale detector
└── worker.ts                  — Call recoverStaleJobs() on startup
```

### recoverStaleJobs()

```typescript
async function recoverStaleJobs(db: Database, queue: Queue) {
  // Find documents stuck in active states with no heartbeat for >2 minutes
  const stale = await db.query(`
    SELECT * FROM documents
    WHERE status IN ('analyzing', 'translating', 'assembling')
    AND updated_at < NOW() - INTERVAL '2 minutes'
  `)

  for (const doc of stale) {
    // Reset in-flight chunks back to pending
    await db.query(`
      UPDATE translation_chunks SET status = 'pending'
      WHERE document_id = $1 AND status = 'translating'
    `, [doc.id])

    // Re-enqueue
    await queue.add('translate', { documentId: doc.id })
    logger.info({ documentId: doc.id }, 'recovered stale job')
  }
}
```

Called on worker startup, and also every 60 seconds via a stale-job detector interval.

### Heartbeat

Worker updates `documents.updated_at = NOW()` every 30 seconds while processing. If it crashes, the timestamp goes stale, and `recoverStaleJobs()` picks it up.

### Idempotency

1. Each chunk has `idempotency_key = SHA-256(document_id + chunk_index + first_100_chars)`
2. Before calling OpenAI: check if `translation_cache` has a hit for this content
3. Before processing a chunk: `SELECT pg_try_advisory_lock(hashtext(idempotency_key))`
   - Lock acquired → process
   - Lock not acquired → another worker has it → skip
4. After completion: release lock, mark chunk completed

### Crash Timeline

```
t=0    Translation starts, 20 chunks
t=10s  Chunks 0–4 completed (in DB)
t=11s  Chunk 5 in-flight
t=11s  ── docker compose restart worker ──
       Graceful: SIGTERM → worker tries to finish current chunk → exits
       Ungraceful: chunk 5 stays as 'translating' in DB
t=20s  Worker restarts
t=21s  recoverStaleJobs():
       → Finds document with status='translating', updated_at is stale
       → Resets chunk 5 to 'pending'
       → Re-enqueues job
t=22s  Translation resumes from chunk 5
       → Chunks 0–4 already 'completed' → skipped
       → Chunk 5: advisory lock acquired → translate → complete
       → Chunks 6–19: continue normally
t=60s  Done. User never knew.
```

### BullMQ Configuration

```typescript
const queue = new Queue('translation', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  }
})

const worker = new Worker('translation', processJob, {
  connection: redis,
  concurrency: 3,
  stalledInterval: 60_000,
  lockDuration: 120_000,
  lockRenewTime: 30_000,
})
```

### Tests
- **Critical: `crash-recovery.test.ts`** — Start translation → kill worker process → restart → verify completion with no duplicate chunks and correct cost
- **Critical: `concurrent.test.ts`** — Submit 3 documents simultaneously → all complete independently, no interleaved chunks, no deadlocks
- `advisory-lock.test.ts` — Two concurrent attempts to process same chunk → only one succeeds
- `idempotency.test.ts` — Chunk with status 'completed' is skipped on retry
- `heartbeat.test.ts` — Stale document detected after heartbeat stops

### Acceptance Criteria

**Criteria 1 — Translations survive interruptions:**
- [ ] Start 20-page translation, `docker compose restart worker` after 5 chunks → translation completes
- [ ] No duplicate chunks in DB after restart
- [ ] Cost is not doubled after restart
- [ ] `docker compose restart postgres` → worker waits and retries until DB is back
- [ ] Frontend reconnects SSE and shows correct progress after restart

**Criteria 2 — Multiple users can work concurrently:**
- [ ] 3 documents submitted simultaneously → all 3 complete without interference
- [ ] Advisory locks prevent two workers from processing the same chunk
- [ ] No deadlocks under concurrent load

---

## Phase 5 — MCP Server

### Goal
Translate documents from Cursor or Claude Code without the web UI. Share the same core service as the REST API.

### Files to Create

```
backend/src/
└── mcp-server.ts              — MCP server with stdio transport
```

### Tools

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `translate_document` | Read a file from disk and translate it | `file_path`, `target_language`, `source_language?` | Job ID + status |
| `get_translation_status` | Check progress of a translation job | `job_id` | Status, progress %, stage, error if any |
| `download_translation` | Get the translated file | `job_id`, `output_directory?` | Output file path |
| `list_supported_languages` | List available languages with codes | (none) | Language list |
| `get_document_cost` | See cost breakdown for a translation | `job_id` | Cost, tokens, model breakdown |

**Why these tools and not "a tool per REST endpoint":** These map to what a developer in Cursor would actually want to do. Not `/api/documents/:id/chunks` or `/health` — those are implementation details. The user thinks "translate this file", "is it done?", "give me the result", "what languages work?", "what did that cost me?"

### MCP Architecture

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TranslationService } from './core/translation-service.js' // SAME core

const server = new Server({ name: 'stark-translator', version: '1.0.0' },
  { capabilities: { tools: {} } })

// TranslationService is the SAME class used by NestJS controllers
const service = new TranslationService(db, redis, openai)

// Each tool delegates to service methods — zero duplication
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'translate_document': {
      const buf = await fs.readFile(args.file_path)
      const doc = await service.createDocument(buf, path.basename(args.file_path), args.target_language, args.source_language)
      await service.startTranslation(doc.id)
      return { content: [{ type: 'text', text: JSON.stringify({ jobId: doc.id, status: 'started' }) }] }
    }
    // ... other tools call same service methods
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

### README Config

**Claude Code** (`~/.claude.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "stark-translator": {
      "command": "docker",
      "args": ["compose", "-f", "/path/to/docker-compose.yml", "run", "--rm", "-T", "mcp"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "stark-translator": {
      "command": "docker",
      "args": ["compose", "-f", "/path/to/docker-compose.yml", "run", "--rm", "-T", "mcp"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

**3-Step Verification:**
1. Start the stack: `docker compose up -d`
2. Ask: "List the supported translation languages" → should return language list
3. Ask: "Translate /path/to/test.pdf to Spanish" → should return a job ID, then check status, then download

### Error Table — Phase 5

| Scenario | Tool Error Message |
|----------|-------------------|
| File not found | "File not found: '{path}'." |
| Permission denied | "Cannot read file: permission denied." |
| Invalid language code | "Unsupported language '{code}'. Use list_supported_languages." |
| Job not found | "No translation found with ID '{id}'." |
| Translation not complete | "Translation is {progress}% complete. Check back shortly." |
| Service unavailable | "Translation service unavailable. Ensure Docker stack is running." |

### Tests
- `mcp-tools.test.ts` — translate_document creates document + enqueues job; get_translation_status returns progress; invalid file path returns clear error; invalid language returns error with suggestion

### Acceptance Criteria
- [ ] MCP server connects from Cursor/Claude Code using only README instructions
- [ ] `translate_document` → `get_translation_status` → `download_translation` works end-to-end
- [ ] MCP server uses same `TranslationService` as REST API (code review verifiable)
- [ ] All tool errors are helpful and actionable

---

## Phase 6 — Frontend Integration

### Goal
Connect the existing React frontend to the real backend. Real file upload, real progress via SSE, real download.

### Files to Modify
- `src/App.jsx` — replace mock logic with real API calls
- `src/components/TranslationCard.jsx` — real progress from SSE
- `src/components/HistoryList.jsx` — real data from GET /api/documents

### API Endpoints

```
POST   /api/documents/upload           → multipart/form-data → { id, name, format, status }
POST   /api/documents/:id/translate    → { targetLanguage, sourceLanguage? } → { jobId }
GET    /api/documents/:id/status       → { status, progress, completedChunks, totalChunks, stage,
                                           error?, cost, qualityScore?, durationMs? }
GET    /api/documents/:id/download     → binary file download
GET    /api/documents                  → [{ id, name, status, from, to, createdAt, qualityScore? }]
POST   /api/documents/:id/cancel       → { status: 'cancelled' }
DELETE /api/documents/:id              → 204
GET    /api/documents/:id/events       → SSE stream
```

### SSE Events

```typescript
// From worker via Redis pub/sub
type SSEEvent = {
  type: 'progress'
  status: DocumentStatus
  progress: number             // 0–100
  completedChunks: number
  totalChunks: number
  stage: 'glossary' | 'translating' | 'assembling'
  costSoFar: number
} | {
  type: 'completed'
  outputPath: string
  totalCostUsd: number
  totalDurationMs: number
  qualityScore: number | null    // BT-Score, displayed on the completed card
} | {
  type: 'failed'
  errorCode: string
  errorMessage: string
}
```

### Translation Quality Display on Frontend

The assessment says: "Pick one measure of translation quality, measure it, and report the number." We measure BT-Score (back-translation consistency) and **show it to the user on the completed translation card.**

**How it works:**
1. After all chunks are translated and before assembly, the worker picks 3 representative chunks
2. For each: translate back to source language, compute word-overlap ratio with original
3. Average = document's `quality_score` (0.0–1.0), stored on the `documents` row
4. Sent to the frontend in the `completed` SSE event as `qualityScore`
5. Displayed on `TranslationCard` when status = complete:

```
┌─────────────────────────────────────────────────┐
│  Q3-Report-2026.pdf          EN → ES            │
│  ● Complete                          100%       │
│  ████████████████████████████████████████        │
│                                                  │
│  Translation complete — ready to download        │
│                                                  │
│  Cost: $0.006  │  Time: 12s  │  Quality: 0.82   │
│                                                  │
│  [ ↓ Download ]                                  │
└─────────────────────────────────────────────────┘
```

**Quality score interpretation (shown as tooltip or small legend):**
- `≥ 0.75` → "High confidence" (green dot)
- `0.50–0.74` → "Acceptable" (yellow dot)
- `< 0.50` → "Low confidence — review recommended" (red dot)

This gives the user a concrete, honest signal about translation reliability. It's not perfect — BT-Score is a crude proxy — but it's measured, real, and visible. A crude honest metric beats a sophisticated unmeasured one.

**Backend implementation (in the translation worker, after all chunks complete):**
```typescript
async function measureQuality(documentId: string, provider: TranslationProvider): Promise<number> {
  // Pick 3 chunks evenly spaced through the document
  const chunks = await db.query(
    `SELECT source_text, translated_text FROM translation_chunks
     WHERE document_id = $1 AND status = 'completed'
     ORDER BY chunk_index`, [documentId]
  )
  const sample = pickEveryNth(chunks, 3)  // pick 3 evenly spaced

  let totalScore = 0
  for (const chunk of sample) {
    const back = await provider.translate(chunk.translated_text, targetLang, sourceLang, minimalContext)
    totalScore += wordOverlapRatio(chunk.source_text, back.translatedText)
  }
  return totalScore / sample.length
}
```

Cost of quality measurement: 3 extra API calls per document (~$0.001). Negligible.

### Frontend Validation (Before Upload — Instant Feedback)

The frontend validates BEFORE the file leaves the browser. This prevents wasting bandwidth uploading a 200 MB file only for the backend to reject it.

```typescript
// In UploadZone.jsx — already using react-dropzone
const ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/markdown': ['.md'],
}
const MAX_SIZE = 100 * 1024 * 1024  // 100 MB

// react-dropzone handles accept + maxSize natively
// Add custom onDropRejected handler for specific messages:
onDropRejected: (rejections) => {
  for (const r of rejections) {
    if (r.errors[0]?.code === 'file-too-large')
      showError(`File is too large (max 100 MB). This file is ${formatSize(r.file.size)}.`)
    if (r.errors[0]?.code === 'file-invalid-type')
      showError(`"${r.file.name}" is not supported. Accepted: PDF, DOCX, MD.`)
  }
}

// Also check on the file card BEFORE translate button is clicked:
// - file.size === 0 → "File is empty"
// - file.size > MAX_SIZE → "File exceeds 100 MB limit"
```

**Why both layers:** Frontend catches 90% of bad uploads instantly (no network round-trip). Backend catches the remaining 10% (spoofed extensions, curl uploads, MCP submissions, corrupted content). Never trust the client alone.

### Frontend Error Display

Every error code maps to a specific message with an icon in the UI. No generic errors. The frontend reads `errorCode` and `errorMessage` from the API and displays the `errorMessage` as-is (messages are already user-facing quality from the backend).

### Acceptance Criteria

**Criteria 3 — Users understand and control ongoing work:**
- [ ] Upload a PDF → file card appears with real filename and size
- [ ] Click Translate → real-time progress bar updates via SSE
- [ ] Progress shows: stage (glossary → translating → assembling), percentage, cost so far
- [ ] Completion → download button works, file downloads
- [ ] Completed card shows: cost, duration, and **quality score (BT-Score)** with confidence indicator
- [ ] Error → specific error message displayed, not generic
- [ ] Cancel button on active translation → stops the job, shows "Cancelled"
- [ ] Page refresh mid-translation → reconnects SSE, shows current progress immediately
- [ ] History shows real translations from DB with quality scores

**Criteria 2 — Multiple users can work concurrently:**
- [ ] Two documents uploaded and translated simultaneously → both complete independently
- [ ] SSE channels are per-document — no cross-talk between concurrent translations

**Validation (dual-layer):**
- [ ] Frontend rejects >100 MB file instantly without uploading
- [ ] Frontend rejects .exe/.zip files instantly with a specific message
- [ ] Backend still rejects bad files even if frontend checks are bypassed (test with curl)

---

## Phase 7 — Output Generation

### Goal
Produce a translated document in the same format as the input. Readable and correctly encoded. Not pixel-perfect — just clean.

### Files to Create

```
backend/src/
├── output/
│   ├── index.ts               — OutputGenerator interface, registry
│   ├── pdf-output.ts          — pdf-lib based PDF generation
│   ├── docx-output.ts         — docx npm package
│   └── markdown-output.ts     — join translated chunks as text
```

### PDF Output Strategy

Not pixel-perfect reconstruction — that's a rabbit hole. Instead:
1. Create a new PDF with `pdf-lib`
2. Embed Noto Sans font (covers Latin, Cyrillic, Greek — ~200 KB)
3. For each chunk's translated text: flow it onto pages with reasonable margins and font size
4. If the source document had images: skip them in output (scope cut, documented)
5. Set PDF metadata (title, language)

This produces a clean, readable translated PDF. Not a clone of the original layout, but a professional document.

**CJK:** Embed Noto Sans CJK subset or use pdf-lib's standard font fallback. If CJK rendering fails, fall back to adding a note: "CJK output may require a CJK-capable PDF viewer."

### DOCX Output Strategy

1. Parse original with mammoth for structure info
2. Use `docx` npm package to generate output
3. Map translated chunks back to paragraphs, headings, list items, table cells
4. Preserve structure: headings → headings, lists → lists, tables → tables
5. Bold/italic/font size: best-effort from mammoth's extraction

### Markdown Output Strategy

Simplest: join translated chunks in order. Preserve markdown syntax (headings, code blocks, tables, links). Code blocks are not translated — pass through as-is.

### Acceptance Criteria
- [ ] Translated PDF opens in any PDF viewer and is readable
- [ ] DOCX output opens in Word/LibreOffice with headings and tables intact
- [ ] Markdown output preserves code blocks untranslated
- [ ] Output file is at `document.output_path` and downloadable via API

---

## Phase 8 — Testing & Quality Measurement

### Goal
Comprehensive tests. The crash-recovery test is the star. Measure and report back-translation quality score.

### Test Structure

```
backend/tests/
├── unit/
│   ├── chunker.test.ts
│   ├── pdf-parser.test.ts
│   ├── docx-parser.test.ts
│   ├── cache.test.ts
│   ├── errors.test.ts
│   └── cost-tracking.test.ts
├── integration/
│   ├── upload-flow.test.ts
│   ├── translation-flow.test.ts
│   ├── crash-recovery.test.ts       ← THE critical test
│   └── mcp-tools.test.ts
├── quality/
│   └── back-translation.test.ts     ← BT-Score measurement
└── fixtures/
    ├── sample-5page.pdf
    ├── sample-with-tables.pdf
    ├── sample-scanned.pdf
    ├── sample-corrupted.pdf
    ├── sample.docx
    └── sample.md
```

### The Critical Crash-Recovery Test

```typescript
test('translation survives worker restart', async () => {
  // 1. Upload a multi-chunk document
  const doc = await uploadDocument('sample-5page.pdf')
  await startTranslation(doc.id, 'es')

  // 2. Wait until some chunks are completed
  await waitForChunks(doc.id, 2)

  // 3. Kill the worker process
  await killWorkerProcess()

  // 4. Verify chunks 0-1 are 'completed', some may be 'translating'
  const midState = await getChunkStatuses(doc.id)
  expect(midState.filter(c => c.status === 'completed').length).toBeGreaterThanOrEqual(2)

  // 5. Restart the worker
  await startWorkerProcess()

  // 6. Wait for completion
  await waitForDocumentStatus(doc.id, 'completed', 120_000)

  // 7. Verify no duplicate chunks
  const chunks = await getChunks(doc.id)
  const indices = chunks.map(c => c.chunkIndex)
  expect(new Set(indices).size).toBe(indices.length)

  // 8. Verify all chunks completed
  expect(chunks.every(c => c.status === 'completed')).toBe(true)
})
```

### Performance Benchmark (run and report in DECISIONS.md)

After integration tests pass, run real translations and fill this table:

```
| Document              | Size (KB) | Pages | Chunks | Parse (ms) | Translate (ms) | Assemble (ms) | Total (s) | Cost ($) |
|-----------------------|-----------|-------|--------|------------|----------------|---------------|-----------|----------|
| sample-5page.pdf      | ...       | 5     | ...    | ...        | ...            | ...           | ...       | ...      |
| sample-20page.pdf     | ...       | 20    | ...    | ...        | ...            | ...           | ...       | ...      |
| sample.docx           | ...       | ...   | ...    | ...        | ...            | ...           | ...       | ...      |
| sample.md             | ...       | 1     | ...    | ...        | ...            | ...           | ...       | ...      |
| 5-page cached (2nd run) | ...     | 5     | ...    | ...        | 0              | ...           | ...       | 0        |
```

This proves: (a) what dominates total time (translation API calls), (b) cache works (2nd run cost = $0), (c) system handles different formats and sizes. Report real numbers, not estimates.

### Back-Translation Quality Measurement

```typescript
// quality/back-translation.test.ts
test('measure BT-Score for English → Spanish', async () => {
  const paragraphs = loadTestParagraphs('fixtures/sample-5page.pdf', 10)
  let totalScore = 0

  for (const para of paragraphs) {
    const forward = await translate(para, 'en', 'es')
    const back = await translate(forward.translatedText, 'es', 'en')
    const score = wordOverlapRatio(para, back.translatedText)
    totalScore += score
  }

  const btScore = totalScore / paragraphs.length
  console.log(`BT-Score (EN→ES): ${btScore.toFixed(3)}`)

  // Write to a file for DECISIONS.md
  writeFileSync('bt-score-results.json', JSON.stringify({ btScore, language: 'en→es', paragraphs: 10 }))

  expect(btScore).toBeGreaterThan(0.5)  // minimum threshold
})

function wordOverlapRatio(original: string, backTranslated: string): number {
  const origWords = new Set(original.toLowerCase().split(/\s+/))
  const backWords = new Set(backTranslated.toLowerCase().split(/\s+/))
  const overlap = [...origWords].filter(w => backWords.has(w)).length
  return overlap / origWords.size
}
```

### Acceptance Criteria
- [ ] `npm test` passes all unit and integration tests
- [ ] Tests use MockProvider — zero real API calls in test suite (except quality/ tests)
- [ ] Crash-recovery integration test passes
- [ ] BT-Score is measured and recorded with a concrete number
- [ ] Test coverage >70% for core modules

---

## Phase 9 — Observability & Documentation

### Goal
Structured logging, cost reporting, and complete documentation that lets a reviewer set up and evaluate the project from README alone.

### Files to Create

```
README.md
DECISIONS.md
PROMPTS.md
backend/src/stats/stats.controller.ts  — GET /api/stats
```

### Logging

Every log entry via pino includes:
- `correlationId` — traces a request across API → Worker → DB
- `documentId` — when relevant
- `component` — `api`, `worker`, `mcp`, `parser`, `agent`
- `event` — `upload_received`, `chunk_translated`, `job_recovered`, etc.

### GET /api/stats

```json
{
  "totalDocuments": 42,
  "completedDocuments": 38,
  "totalCostUsd": 3.45,
  "avgCostPerDocument": 0.09,
  "cacheHitRate": 0.28,
  "totalInputTokens": 450000,
  "totalOutputTokens": 430000
}
```

### README.md Structure

1. **What this is** — one paragraph, who it's for
2. **Quick start** — `cp .env.example .env`, add API key, `docker compose up --build`
3. **Architecture** — diagram + explanation
4. **API reference** — endpoints with curl examples
5. **MCP setup** — Claude Code + Cursor config, 3-step verification
6. **Testing** — how to run tests
7. **Cost per document** — measured numbers
8. **Why the agent earns its place** — glossary extraction explanation

### DECISIONS.md Structure

1. **Stack decisions** — PostgreSQL over SQLite (why), BullMQ over bare Redis (why), pdf-parse over pdf.js (why)
2. **What I cut and why** — OCR, images, RTL layout, quality validation agent, Batch API, auth
3. **Where the agent earns its place** — GlossaryAgent vs plain completion, with concrete example of the tool-calling loop
4. **What dominates cost** — output tokens at 80%+, with measured breakdown per document size
5. **What dominates latency** — translation API calls at 95%+, with measured timing breakdown
6. **Format extensibility** — how DOCX/Markdown prove the parser interface works, how to add HTML in 10 min
7. **Semantic chunking** — why paragraph/sentence splitting beats fixed-token splitting, with coherence examples
8. **Speed vs coherence trade-off** — sequential chunk translation (with context carry) is ~2× slower than parallel but produces coherent output. Documented as a conscious choice.
9. **Measured numbers** — cost per document table, BT-Score, cache hit rate, performance benchmark table
10. **What I'd build next** — with more time

### PROMPTS.md Structure

The full prompt chain used to build the project. For each prompt:
- What was asked
- What the AI produced
- What I changed and why (at least 3 cases where AI output was rejected/corrected)

### .env.example

```env
OPENAI_API_KEY=sk-proj-your-key-here
POSTGRES_PASSWORD=stark_dev_password
# Optional overrides:
# LOG_LEVEL=debug
# FILE_STORAGE_PATH=/app/data/files
```

### Acceptance Criteria
- [ ] `docker compose logs worker` shows structured JSON with correlation IDs
- [ ] `/api/stats` returns real measured cost data
- [ ] README lets a reviewer set up everything from scratch with zero questions
- [ ] PROMPTS.md has ≥3 cases where AI output was rejected/corrected
- [ ] DECISIONS.md has measured BT-Score and cost numbers
- [ ] `.env.example` documents all required environment variables

---

## Execution Order & Time Budget

```
Phase 1 — Scaffold + Docker + DB            ~3 hours
Phase 2 — Parsing + Chunking                ~3 hours
Phase 3 — Translation Pipeline + Agent       ~4 hours
Phase 4 — Crash Recovery                     ~2 hours
Phase 5 — MCP Server                         ~2 hours
Phase 6 — Frontend Integration               ~2 hours
Phase 7 — Output Generation                  ~2 hours
Phase 8 — Testing + Quality Metric           ~2 hours
Phase 9 — Docs + Observability               ~2 hours
                                            ─────────
                                            ~22 hours
```

Phase 4 (crash recovery) and Phase 8 (tests, especially the crash test) are where the assessment is won or lost. Don't rush them.

---

## Appendix: Supported Languages

```typescript
const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ar', name: 'Arabic' },
] as const
```

## Appendix: Complete Error Code Reference

| Code | HTTP | User Message |
|------|------|--------------|
| `NO_FILE_PROVIDED` | 400 | No file was provided. Please select a file to upload. |
| `FILE_TOO_LARGE` | 413 | File exceeds the 100 MB limit. |
| `UNSUPPORTED_FORMAT` | 415 | '.{ext}' is not supported. Accepted: PDF, DOCX, MD. |
| `CORRUPT_FILE` | 422 | This file is corrupted and cannot be opened. |
| `PASSWORD_PROTECTED` | 422 | This PDF is password-protected. Remove the password and re-upload. |
| `SCANNED_PDF_DETECTED` | 422 | This PDF contains scanned images instead of extractable text. |
| `NO_EXTRACTABLE_TEXT` | 422 | No text could be extracted from this file. |
| `DOCUMENT_TOO_LONG` | 422 | This document has {n} pages (limit: 500). |
| `PARSE_TIMEOUT` | 422 | Parsing took too long. The file may be too complex. |
| `SECURITY_VIOLATION` | 422 | This file failed security validation. |
| `INVALID_LANGUAGE` | 400 | Unsupported language '{code}'. |
| `RATE_LIMITED` | 429 | Translation temporarily slowed by high demand. Retrying automatically. |
| `PROVIDER_ERROR` | 502 | Translation service encountered a temporary issue. Retrying. |
| `PROVIDER_TIMEOUT` | 504 | Translation request timed out. Retrying. |
| `AUTH_FAILED` | 500 | API key is invalid or expired. |
| `CONTENT_FILTERED` | 422 | Content flagged by AI safety filter. Chunk skipped. |
| `GLOSSARY_FAILED` | — | (internal, non-blocking) Glossary extraction failed. Continuing without glossary. |
| `DB_CONNECTION_FAILED` | 503 | Service temporarily unavailable. |
| `REDIS_CONNECTION_FAILED` | 503 | Service temporarily unavailable. |
| `STORAGE_FULL` | 507 | Server storage is full. |
| `DOCUMENT_NOT_FOUND` | 404 | Document not found. |
| `TRANSLATION_NOT_COMPLETE` | 409 | Translation is not yet complete ({progress}%). |
| `CANCELLED` | 200 | Translation was cancelled by the user. |
