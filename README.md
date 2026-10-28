# Stark Document Translator

Upload a PDF, DOCX, or Markdown file → pick a language → get a translated file back.

Self-hosted. Your API key, your data. Survives container crashes mid-translation.

---

## Quick Start

```bash
git clone <repo-url> stark-doc-translator
cd stark-doc-translator
cp .env.example .env
# Edit .env — set your OpenAI key:
#   OPENAI_API_KEY=sk-proj-...

docker compose up --build
# Wait ~30s for healthy checks, then:
open http://localhost:3000
```

Six containers start: PostgreSQL, Redis, API (`:4000`), worker, frontend (`:3000`), and MCP (on-demand).

Verify: `curl http://localhost:4000/health` → `{"status":"ok"}`

---

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │              Docker Compose                  │
                         │                                              │
  ┌──────────┐    REST   │  ┌──────────┐        ┌───────────────────┐  │
  │ Frontend │──────────▶│  │ NestJS   │──SQL──▶│    PostgreSQL     │  │
  │ React    │◀───SSE────│  │ API :4000│        │ docs, chunks,     │  │
  │ :3000    │           │  └────┬─────┘        │ glossaries, cache │  │
  └──────────┘           │       │enqueue       └───────────────────┘  │
                         │       ▼                                      │
  ┌──────────┐   stdio   │  ┌─────────┐         ┌──────────┐          │
  │ Claude / │──────────▶│  │  Redis   │◀─poll──│  Worker   │          │
  │ Cursor   │           │  │  BullMQ  │        │ translate │          │
  └──────────┘           │  └─────────┘         │ pipeline  │          │
        │                │                       └──────────┘          │
        └───────────────▶│  ┌──────────┐                               │
             MCP stdio   │  │MCP Server│─── same DB + queue ──────────│
                         │  └──────────┘                               │
                         └──────────────────────────────────────────────┘
```

### Translation pipeline

1. **Upload** → validate (magic bytes, size, format), store file, insert DB record
2. **Queue** → BullMQ job enqueued in Redis
3. **Parse** → pdf-parse / mammoth / direct-read into content blocks
4. **Plan chunks** → rule-based semantic chunker decides boundaries (zero tokens)
5. **Glossary** → one OpenAI call extracts domain terms (brands, technical jargon)
6. **Translate** → 4 parallel workers, each chunk gets glossary + context from prior chunk. Direct API call for plain text; agent with `validate_structure` tool for tables
7. **Assemble** → PDF / DOCX / MD output generated
8. **Complete** → status updated, file downloadable

**Crash recovery:** on startup, the worker re-queues any documents stuck in intermediate states. Chunk-level idempotency (SHA-256 + PostgreSQL advisory locks) means completed chunks are never re-translated.

---

## Translate a PDF (Web UI)

1. Open **http://localhost:3000**
2. Drop a PDF (or DOCX / MD) into the upload zone
3. Pick a target language → click **Translate**
4. Watch progress: analyzing → translating → assembling → completed
5. Click **Download**

---

## Translate via API

```bash
# Upload
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@document.pdf" -F "targetLanguage=es"
# → {"id": "abc-123", ...}

# Start translation
curl -X POST http://localhost:4000/api/documents/abc-123/translate \
  -H "Content-Type: application/json" -d '{"targetLanguage": "es"}'

# Watch progress (SSE stream)
curl -N http://localhost:4000/api/documents/abc-123/events

# Download when done
curl -o translated.pdf http://localhost:4000/api/documents/abc-123/download
```

Other endpoints: `GET /api/documents` (list), `GET /api/documents/:id/status` (poll), `POST /api/documents/:id/cancel`, `DELETE /api/documents/:id`, `GET /api/stats`, `GET /health`.

---

## MCP Server (Cursor / Claude Code)

Five tools: `translate_document`, `get_translation_status`, `download_translation`, `list_supported_languages`, `get_document_cost`.

### Setup for Cursor

A `.cursor/mcp.json` is included in the repo. If you cloned to a different location, edit the path inside it. The format:

```json
{
  "mcpServers": {
    "stark-translator": {
      "command": "docker",
      "args": [
        "compose", "-f", "/full/path/to/stark-doc-translator/docker-compose.yml",
        "run", "--rm", "-i", "mcp"
      ],
      "transportType": "stdio"
    }
  }
}
```

### Setup for ChatGPT (desktop app only)

Open **Settings → Beta features → MCP Servers** (enable if needed), then **Settings → MCP Servers → Add Server**:

```json
{
  "stark-translator": {
    "command": "docker",
    "args": [
      "compose", "-f", "/full/path/to/stark-doc-translator/docker-compose.yml",
      "run", "--rm", "-i", "mcp"
    ]
  }
}
```

> MCP is only available in the ChatGPT desktop app (macOS / Windows), not in the browser.

### Setup for Claude Code

Add to `~/.claude/claude_desktop_config.json` (same args format as above):

```json
{
  "mcpServers": {
    "stark-translator": {
      "command": "docker",
      "args": [
        "compose", "-f", "/full/path/to/stark-doc-translator/docker-compose.yml",
        "run", "--rm", "-i", "mcp"
      ],
      "transportType": "stdio"
    }
  }
}
```

### Verify it works

Restart Cursor / Claude Code after editing the config, then try:

> "List supported translation languages"

The agent calls `list_supported_languages` and returns 14 languages.

### End-to-end MCP translation

> "Translate the file at /path/to/sample.md to French"

The agent calls `translate_document` → polls `get_translation_status` → returns the file path via `download_translation`. No browser needed.

---

## Testing

### Automated (199 tests, ~1 second)

```bash
cd backend
npm test            # run once
npm run test:watch  # watch mode
```

```
tests/
├── unit/           19 files  — parsers, chunker, cache, security, output, streaming, costs
├── integration/     4 files  — upload flow, translation flow, crash recovery, MCP tools
├── quality/         1 file   — BT-Score (back-translation consistency metric)
└── fixtures/        sample PDFs, DOCX, MD
```

All tests use `MockProvider` — zero real API calls, zero cost.

### Manual testing guide

#### 1. PDF round-trip

```bash
# Upload the 100-page sample PDF
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@backend/tests/fixtures/sample-200-pages.pdf" \
  -F "targetLanguage=es" -F "sourceLanguage=en"

# Translate (use the returned ID)
curl -X POST http://localhost:4000/api/documents/{id}/translate \
  -H "Content-Type: application/json" -d '{"targetLanguage":"es"}'

# Watch progress
curl -N http://localhost:4000/api/documents/{id}/events
# → progress 5% → 10% → ... → 100%

# Download
curl -o translated.pdf http://localhost:4000/api/documents/{id}/download
# Open translated.pdf — text should be in Spanish
```

#### 2. Second format (DOCX or Markdown)

```bash
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@backend/tests/fixtures/sample.md" \
  -F "targetLanguage=fr" -F "sourceLanguage=en"
# Translate, download — you get a .md file back in French
```

```bash
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@backend/tests/fixtures/sample.docx" \
  -F "targetLanguage=de" -F "sourceLanguage=en"
# Translate, download — you get a .docx file back in German
```

#### 3. Crash recovery

```bash
# Start a translation, then kill the worker mid-progress:
docker compose stop worker

# Check status — still shows "translating" with partial chunks:
curl http://localhost:4000/api/documents/{id}/status

# Restart the worker:
docker compose start worker

# Worker logs will show:
#   "found orphaned documents — re-queuing"
#   Completed chunks are skipped (from cache), only remaining chunks translate
#   Document completes normally
```

#### 4. Edge cases

```bash
# Corrupted PDF → fails gracefully with PARSE_FAILED
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@backend/tests/fixtures/sample-corrupted-real.pdf" -F "targetLanguage=es"
# Translate → status: "failed", errorCode: "PARSE_FAILED"

# Unsupported format → 415 error
echo "test" > /tmp/test.xyz
curl -X POST http://localhost:4000/api/documents/upload \
  -F "file=@/tmp/test.xyz" -F "targetLanguage=es"
# → 415 "'xyz' is not supported"

# Translation cache — same content translated twice costs $0 the second time
```

#### 5. System stats

```bash
curl http://localhost:4000/api/stats
# → totalDocuments, completedDocuments, totalCostUsd, cacheHitRate, etc.
```

### Cleanup

```bash
docker compose down -v   # stops everything, removes volumes
```

---

## Supported Languages

English, Spanish, German, French, Italian, Portuguese, Dutch, Swedish, Polish, Ukrainian, Japanese, Korean, Chinese (Simplified), Arabic.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `POSTGRES_PASSWORD` | No | `stark_dev_password` | PostgreSQL password |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection |
| `WORKER_CONCURRENCY` | No | `3` | Parallel BullMQ jobs |
| `MAX_FILE_SIZE_MB` | No | `100` | Upload size limit |
| `SENTRY_DSN` | No | — | Sentry error tracking (optional) |

Full list in `.env.example`.

---

## Project Structure

```
├── backend/src/
│   ├── main.ts                       API server (NestJS)
│   ├── worker.ts                     BullMQ worker + orphan resume
│   ├── mcp-server.ts                 MCP server (5 tools, stdio)
│   ├── agents/translation-agent.ts   Direct OpenAI calls + agent fallback
│   ├── agents/semantic-chunk-agent.ts Rule-based chunker (zero tokens)
│   ├── jobs/                         BullMQ processor + queue service
│   ├── parsers/                      PDF / DOCX / MD parsers
│   ├── output/                       PDF / DOCX / MD output generators
│   ├── documents/                    Upload / status / download controller
│   └── db/schema.ts                  4 tables: documents, chunks, glossaries, cache
├── src/                              React frontend (Vite)
├── docker-compose.yml                6 services
├── DECISIONS.md                      Technical decisions + measured numbers
├── PROMPTS.md                        AI prompts used in the system
└── .env.example                      All environment variables
```

---

## Acceptance Checklist

- [x] Fresh `git clone` + `docker compose up --build` runs without errors
- [x] Upload a PDF → get a translated PDF back
- [x] Second format works (DOCX and Markdown)
- [x] MCP server connects from Cursor / Claude Code using only this README
- [x] Document can be translated end-to-end through MCP alone
- [x] Test suite passes (199 tests, 24 files, ~1 second)
- [x] README includes a testing guide
- [x] `PROMPTS.md` and `DECISIONS.md` are complete and honest
- [x] No secrets committed (`.gitignore` covers `.env`, `data/`, `node_modules/`)
- [x] `.env.example` provided with all variables documented
