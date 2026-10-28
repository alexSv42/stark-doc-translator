# Stark Document Translator — Architecture & Pitfall Analysis

## Table of Contents
1. [Pitfalls & Risks](#1-pitfalls--risks)
2. [Prompt Chain — Spectre Development Approach](#2-prompt-chain--spectre-development-approach)
3. [Agent Architecture — Vercel AI SDK vs LangChain vs OpenAI Agents SDK](#3-agent-architecture)
4. [PDF Structure Handling](#4-pdf-structure-handling)
5. [Single Agent vs Multi-Agent](#5-single-agent-vs-multi-agent)
6. [Recommended Architecture](#6-recommended-architecture)

---

## 1. Pitfalls & Risks

### 1.1 PDF Chunking — The Seam Problem

**The core problem:** A 200-page PDF doesn't fit in a single LLM context window (GPT-4o: ~128k tokens ≈ 40-60 pages of dense text). You MUST chunk. But chunking introduces seams.

**Pitfalls:**
| Pitfall | Risk Level | Example |
|---------|-----------|---------|
| Mid-sentence splits | 🔴 High | "The company's annual re-" / "-venue exceeded…" — each chunk translated independently produces incoherent output |
| Terminology drift | 🔴 High | Chunk 1 translates "Controller" as "Controlador", Chunk 5 translates it as "Regulador" — same document, two different words |
| Pronoun resolution across chunks | 🟡 Medium | Last sentence of chunk: "She will present it." — next chunk has no idea who "she" is |
| Table split across pages | 🔴 High | Table header on page 12, data rows on page 13 — if you chunk by page, the chunk with data rows has no column names |
| Numbered lists / references | 🟡 Medium | "As described in Section 3.2" — the translator doesn't know what Section 3.2 says |

**Mitigation strategy:**
```
┌─────────────────────────────────────────────┐
│  Document                                    │
│  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐       │
│  │Chunk│──│Chunk│──│Chunk│──│Chunk│        │
│  │  1  │  │  2  │  │  3  │  │  4  │        │
│  └─────┘  └─────┘  └─────┘  └─────┘       │
│     │  overlap  │  overlap  │  overlap       │
│     └───────────┘───────────┘                │
│                                              │
│  + Global context header per chunk:          │
│    "Document title: ..., glossary: ...,      │
│     previous chunk ended with: ..."          │
└─────────────────────────────────────────────┘
```

- **Overlapping chunks**: 2-3 paragraphs overlap between adjacent chunks
- **Global glossary**: First pass extracts key terms → build a glossary → inject into every chunk's system prompt
- **Context carry**: Send the last 2-3 translated sentences from chunk N as context to chunk N+1
- **Structural awareness**: Parse the document structure FIRST (headings, tables, lists) and chunk at structural boundaries, never mid-paragraph

### 1.2 Queue & Job Persistence

**The assessment explicitly tests this:** "during review we kill and restart your containers mid-translation."

**Pitfalls:**
| Pitfall | Risk Level | Mitigation |
|---------|-----------|------------|
| In-memory queue lost on crash | 🔴 Critical | Use persistent queue — BullMQ + Redis, or SQLite-backed job table |
| Partial results lost | 🔴 Critical | Store each translated chunk immediately to disk/DB as it completes |
| Double-billing on retry | 🟡 Medium | Idempotency keys per chunk — check if chunk N already translated before calling OpenAI |
| Zombie jobs stuck in "processing" | 🟡 Medium | Heartbeat + TTL — if no heartbeat for 60s, requeue |
| File upload lost before processing | 🔴 Critical | Store uploaded file to persistent volume BEFORE acknowledging upload |

**Recommended stack:**
```
BullMQ (Redis-backed queue)
├── translate-job (per document)
│   ├── chunk-1 ✅ (stored in DB/filesystem)
│   ├── chunk-2 ✅ (stored)
│   ├── chunk-3 🔄 (in progress — will be retried on restart)
│   ├── chunk-4 ⏳ (pending)
│   └── ...
│
│  On restart: scan for jobs in "active" state → requeue from last incomplete chunk
```

**Why BullMQ over bare Redis or in-memory:**
- Built-in retry with exponential backoff
- Job progress tracking (maps directly to the frontend progress bar)
- Stalled job detection (if worker dies, jobs auto-requeue after timeout)
- `docker compose` just adds a Redis service — minimal overhead

### 1.3 Concurrent Uploads

**Pitfalls:**
| Pitfall | Risk Level | Mitigation |
|---------|-----------|------------|
| Resource exhaustion | 🔴 High | Concurrency limit: max 3 active translations, queue the rest |
| OpenAI rate limits | 🟡 Medium | Token bucket / rate limiter on API calls (max N requests/minute) |
| Memory spike (large PDFs) | 🔴 High | Stream file to disk, parse with streaming PDF library, don't load entire file into memory |
| Database contention | 🟢 Low | Use SQLite WAL mode or Postgres — both handle concurrent writes fine |
| File name collision | 🟡 Medium | Use UUID-based paths, never user-provided filenames for storage |

### 1.4 Cost Explosion

A 200-page document ≈ 100k-150k tokens input + output. At GPT-4o pricing ($2.50/1M input, $10/1M output):
- Single document cost: **$0.50 - $2.00**
- With overlapping context + glossary extraction: multiply by ~1.3x
- If retried due to errors: multiply again

**Mitigations:**
- Translation memory cache (hash paragraph → check cache first)
- Use GPT-4o-mini for bulk content, GPT-4o only for complex passages (detected by agent)
- Per-document cost tracking with budget cap
- Batch API for non-urgent translations (50% cheaper)

### 1.5 Other Critical Pitfalls

| Pitfall | Why It Matters |
|---------|---------------|
| **Corrupted PDF** | pdf-parse crashes → need try/catch + user-friendly error |
| **Scanned PDF (image-only)** | No text to extract → need OCR detection, either use Tesseract or tell user "this PDF contains images, not text" |
| **RTL languages** (Arabic, Hebrew) | PDF rendering with RTL text needs special handling |
| **Mixed-language source** | Document partly in English, partly in French → auto-detect fails per-section |
| **PDF/A compliance** | Some organizations require output PDFs to be PDF/A compliant |
| **Font embedding** | Translated text in CJK characters needs fonts embedded in output PDF |

---

## 2. Prompt Chain — Spectre Development Approach

"Spectre" development means building in focused, sequential phases — each phase has a clear goal, produces a concrete artifact, and feeds into the next. Here's the exact chain:

### Phase 0: Foundation (Prompts 1-3)

```
PROMPT 1 — Project scaffold
"Set up a Node.js + Express backend with TypeScript. Add:
 - Docker Compose with Redis, the app, and a worker process
 - BullMQ for job queuing
 - SQLite for job/translation storage
 - File upload endpoint (multipart/form-data)
 - Health check endpoint
 - Proper error handling middleware
 Do NOT add any AI/translation logic yet."

PROMPT 2 — Data model
"Define the core data model:
 - Document: id, originalName, storagePath, format, status, sourceLanguage, targetLanguage, createdAt, completedAt
 - TranslationChunk: id, documentId, chunkIndex, sourceText, translatedText, status, tokenCount, costUsd
 - TranslationJob: id, documentId, status, progress, errorMessage, retryCount
 Use Drizzle ORM with SQLite. Add migrations."

PROMPT 3 — File processing pipeline (no AI)
"Build the document processing pipeline WITHOUT translation:
 - PDF parser (pdf-parse) that extracts text with page boundaries
 - DOCX parser (mammoth) that extracts text with structure
 - Chunking engine: splits extracted text into chunks of max 3000 tokens
   with 200-token overlap, never splitting mid-sentence or mid-paragraph
 - Output PDF generator (pdf-lib) that takes translated chunks and
   reassembles them
 Add unit tests for the chunking logic."
```

### Phase 1: Core Translation (Prompts 4-6)

```
PROMPT 4 — LLM integration layer
"Create a TranslationService behind an interface:
 interface TranslationProvider {
   translate(text: string, from: string, to: string, context?: TranslationContext): Promise<TranslationResult>
 }
 Implement OpenAITranslationProvider using the OpenAI chat completions API.
 Add a MockTranslationProvider for tests.
 Include: retry logic, timeout, cost tracking per call, structured error types."

PROMPT 5 — Translation worker
"Build the BullMQ worker that:
 1. Picks up a translation job
 2. Loads the document chunks from DB
 3. For each chunk: calls TranslationProvider with context from previous chunk's last 3 sentences
 4. Stores each translated chunk immediately (crash-safe)
 5. Updates job progress after each chunk
 6. On completion: triggers PDF reassembly
 7. On failure: marks job as failed with specific error
 Ensure idempotency: if chunk already translated, skip it."

PROMPT 6 — Glossary extraction agent (OpenAI Agents SDK)
"This is where the agent earns its place. Build a GlossaryAgent using openai-agents that:
 1. Receives the first 5000 tokens of a document
 2. Uses tool calling to:
    - extract_terms(text) → identifies domain-specific terms, proper nouns, brand names
    - lookup_existing_glossary(terms) → checks translation memory for known translations
    - create_glossary_entry(term, translation) → stores new term/translation pair
 3. Produces a glossary object injected into every chunk's translation prompt
 WHY AGENT HERE: This is a genuine multi-step reasoning task. The agent needs to:
   - Decide which terms are domain-specific (judgment, not rules)
   - Check if translations already exist
   - Resolve conflicts between existing translations
   - A plain completion can't do tool calling loops."
```

### Phase 2: Resilience & Quality (Prompts 7-9)

```
PROMPT 7 — Crash recovery
"Implement restart recovery:
 - On worker startup, query for jobs with status='active'
 - For each: find the last completed chunk index
 - Re-queue from that chunk onward
 - Add a stalled-job detector: if a job's lastHeartbeat is >60s ago, mark as stalled and requeue
 Write an integration test that:
   1. Starts a translation
   2. Kills the worker mid-way
   3. Restarts the worker
   4. Verifies translation completes without duplicate chunks"

PROMPT 8 — Error handling
"Handle every failure mode:
 - Corrupted PDF: detect and return 'INVALID_FORMAT' error with message
 - Scanned/image PDF: detect lack of extractable text, return 'SCANNED_PDF_NOT_SUPPORTED'
 - File too large (>50MB): reject at upload
 - Unsupported format: reject with supported formats list
 - OpenAI rate limit (429): exponential backoff with jitter
 - OpenAI server error (500/502/503): retry up to 3 times
 - OpenAI timeout: retry with shorter chunk
 - Context window exceeded: auto-split chunk smaller
 All errors must surface to the frontend with actionable messages."

PROMPT 9 — Quality validation
"Add a translation quality check:
 - After translating a chunk, do a cheap validation call (GPT-4o-mini):
   'Rate this translation 1-10 for accuracy. If <6, flag for retranslation.'
 - Track quality scores per document
 - If >20% of chunks flag low quality, alert the user
 - Store the quality metric in the DB for reporting"
```

### Phase 3: MCP & Polish (Prompts 10-12)

```
PROMPT 10 — MCP server
"Build an MCP server (using @modelcontextprotocol/sdk) that exposes:
 Tools:
   - translate_document(file_path, target_language, source_language?) → job_id
   - get_translation_status(job_id) → { status, progress, error? }
   - download_translation(job_id) → file_path
 Resources:
   - translation://history → list of recent translations
   - translation://glossary/{language_pair} → current glossary
 The MCP server calls the same core service as the web UI — no duplication.
 Add stdio transport for Claude Code / Cursor integration."

PROMPT 11 — Frontend integration
"Connect the React frontend to the backend:
 - POST /api/documents/upload → upload file
 - POST /api/documents/{id}/translate → start translation
 - GET /api/documents/{id}/status → poll for progress (or WebSocket)
 - GET /api/documents/{id}/download → download translated file
 - GET /api/documents → list history
 Add real-time progress updates via Server-Sent Events (SSE)."

PROMPT 12 — Observability & docs
"Add:
 - Structured logging (pino) with correlation IDs per request
 - Cost tracking: log OpenAI API cost per call, sum per document
 - P95 latency measurement per document size bucket
 - Docker health checks
 - README.md with architecture, setup, and MCP config
 - DECISIONS.md with trade-offs
 - PROMPTS.md with this prompt chain"
```

### Prompt Chain Summary

```
Phase 0: Foundation          Phase 1: Core Translation     Phase 2: Resilience         Phase 3: MCP & Polish
┌──────────┐                ┌──────────┐                  ┌──────────┐                ┌──────────┐
│ Scaffold │──────────────→ │ LLM Layer│──────────────→  │ Recovery │──────────────→ │ MCP      │
│ Data Model│               │ Worker   │                  │ Errors   │                │ Frontend │
│ Parsing  │                │ Agent    │                  │ Quality  │                │ Observ.  │
└──────────┘                └──────────┘                  └──────────┘                └──────────┘
   ~4 hours                    ~6 hours                     ~4 hours                    ~4 hours
```

---

## 3. Agent Architecture

### Vercel AI SDK vs LangChain vs OpenAI Agents SDK

The assessment **requires** OpenAI Agents SDK (`openai-agents`). But here's the honest comparison:

| Criterion | OpenAI Agents SDK | Vercel AI SDK | LangChain |
|-----------|------------------|---------------|-----------|
| **Assessment compliance** | ✅ Required | ❌ Not accepted | ❌ Not accepted |
| **Tool calling** | First-class, native | First-class | Over-abstracted |
| **Streaming** | Built-in | Excellent (RSC support) | Verbose |
| **Complexity** | Low — thin wrapper | Low — framework-native | 🔴 High — deep abstraction layers |
| **Lock-in** | OpenAI only | Multi-provider | Multi-provider |
| **Node.js support** | ✅ `openai-agents` npm | ✅ `ai` npm | ✅ `langchain` npm |
| **Multi-agent** | `Handoff` built-in | Manual | `AgentExecutor` + chains |
| **Debugging** | OpenAI Traces | Basic | LangSmith (paid) |
| **Overhead per call** | Minimal | Minimal | 🔴 Significant (chain overhead) |
| **When to use** | Structured pipelines with tools | React/Next.js streaming UI | Complex multi-model orchestration with retrieval |

### Verdict: OpenAI Agents SDK (Required + Best Fit)

**Why it's the right choice for THIS project:**
1. The assessment mandates it
2. Document translation is an OpenAI-only task (no need for multi-provider)
3. Tool calling is native and clean — define tools as functions, the SDK handles the loop
4. `Handoff` pattern lets you cleanly separate concerns (Glossary Agent → Translation Agent → Validation Agent)
5. Minimal overhead — important when you're processing 200 chunks

**Where Vercel AI SDK would complement (not replace):**
- If you want streaming UI updates in the React frontend, use `ai` for the frontend SSE/streaming rendering
- The backend pipeline stays on `openai-agents`

**Where LangChain is overkill:**
- LangChain's abstraction layers add latency and complexity with no benefit here
- No RAG needed (no vector store, no retrieval)
- The chain/agent abstractions are heavier than what `openai-agents` gives you natively

---

## 4. PDF Structure Handling

### 4.1 The Problem Space

PDFs are NOT documents — they're drawing instructions. A PDF says "draw character 'H' at position (72, 650)" — it has no concept of "paragraph" or "table."

```
┌──────────────────────────────────────────────────────┐
│  What you THINK a PDF is:    │  What a PDF ACTUALLY is:│
│                              │                         │
│  Heading 1                   │  Tj(H) at (72,700)      │
│  Paragraph of text that      │  Tj(e) at (78,700)      │
│  flows naturally...          │  Tj(a) at (84,700)      │
│                              │  Tj(d) at (90,700)      │
│  | Col1 | Col2 |             │  ... 500 more ops       │
│  | Data | Data |             │  re 72 400 200 100      │
│                              │  S (stroke rectangle)   │
│  [image.png]                 │  Do /Im1 (draw image)   │
└──────────────────────────────┴─────────────────────────┘
```

### 4.2 Content Types & Challenges

| Content Type | Challenge | Solution |
|-------------|-----------|----------|
| **Plain text** | Text extraction loses paragraph boundaries | Use pdf-parse + heuristic line-joining (if line ends without period, join with next) |
| **Tables** | No semantic table structure in PDF | Use Tabula-js or Camelot to detect table regions, extract as markdown tables, translate table contents, re-render |
| **Images with text** | Text baked into image pixels | Detect with pdf.js, OCR with Tesseract.js, translate OCR output, overlay translated text |
| **Headers/footers** | Repeated on every page | Detect by position consistency across pages, translate ONCE, apply to all |
| **Multi-column layouts** | Text extraction interleaves columns | Detect columns by x-coordinate clustering, extract column-by-column |
| **Footnotes** | Connected to body text by reference | Extract with reference numbers, translate in context of referring paragraph |
| **Mathematical formulas** | LaTeX/MathML must not be translated | Detect and preserve — regex for $$...$$ and known math patterns |
| **Code blocks** | Must preserve code, translate comments only | Detect by monospace font / indentation patterns |

### 4.3 Recommended PDF Strategy (Pragmatic)

**Tier 1 — MVP (do this first):**
```
pdf-parse → raw text → chunk → translate → pdf-lib (new PDF with translated text)
```
- Loses formatting but works for 80% of text-heavy PDFs
- Fast to implement, reliable
- Good enough for the assessment

**Tier 2 — Structural preservation:**
```
pdf.js → extract text WITH positions → detect blocks (headings, paragraphs, tables)
→ translate block-by-block → pdf-lib with layout matching original positions
```
- Preserves approximate layout
- Tables still challenging

**Tier 3 — Full fidelity (if time allows):**
```
pdf.js → full page analysis → detect: text regions, table regions, image regions
→ for text: translate in place
→ for tables: Tabula extraction → translate cells → re-render table
→ for images with text: skip or OCR + overlay
→ Reassemble with original styling (fonts, colors, spacing)
```

### 4.4 OCR / Scanned PDF Detection

```javascript
function isScannedPdf(pdfData) {
  const textLength = pdfData.text.replace(/\s/g, '').length
  const pageCount = pdfData.numpages
  const avgCharsPerPage = textLength / pageCount

  // A typical text page has 1500-3000 characters
  // A scanned page has <50 characters (maybe page numbers)
  if (avgCharsPerPage < 100) {
    return { scanned: true, confidence: 'high' }
  }
  if (avgCharsPerPage < 500) {
    return { scanned: true, confidence: 'medium' }
  }
  return { scanned: false }
}
```

**For scanned PDFs, options are:**
1. **Reject with message**: "This PDF appears to be scanned. OCR processing is not yet supported." (honest, fast)
2. **Tesseract.js OCR**: Works but slow (~5-10 seconds per page) and accuracy varies
3. **GPT-4o Vision**: Send page images to GPT-4o with vision → extract text → translate (expensive but accurate)

---

## 5. Single Agent vs Multi-Agent

### The Question

Should the translation pipeline use one agent that does everything, or multiple specialized agents?

### Analysis

**Single Agent:**
```
User → [Upload] → [ MEGA AGENT ] → [Download]
                   Does everything:
                   - Detect language
                   - Extract glossary
                   - Translate chunks
                   - Validate quality
                   - Handle errors
```
**Problems:**
- System prompt becomes massive (2000+ tokens wasted per API call × 200 chunks = 400k wasted tokens)
- Agent can get confused between tasks
- Can't use different models for different tasks (expensive model for glossary, cheap for bulk translation)
- Harder to debug: "why did chunk 47 fail?" — was it a glossary issue or a translation issue?

**Multi-Agent (Recommended):**
```
User → [Upload] → Pipeline:

1. FORMAT AGENT (runs once)
   ├── Detects document type, language, structure
   ├── Tools: detect_language(), analyze_structure(), detect_scanned_pdf()
   └── Output: DocumentProfile { lang, structure, isScanned, pageCount }

2. GLOSSARY AGENT (runs once) ← THIS is where openai-agents earns its place
   ├── Extracts domain terms from first 5000 tokens
   ├── Tools: extract_terms(), lookup_glossary_cache(), save_term()
   ├── Multi-step reasoning: decide which terms matter, check cache, resolve conflicts
   └── Output: Glossary { term → translation }

3. TRANSLATION WORKER (runs per chunk — NOT an agent, just completion)
   ├── Plain chat completion with glossary in system prompt
   ├── No tool calling needed — just translate text
   └── Output: translated text per chunk

4. VALIDATION AGENT (runs per chunk, cheap model)
   ├── Quick quality check using GPT-4o-mini
   ├── Tools: flag_low_quality(), request_retranslation()
   └── Output: quality score, retry flag

5. ASSEMBLY (no AI)
   └── Combines translated chunks into output PDF
```

### Why Multi-Agent Wins

| Factor | Single | Multi |
|--------|--------|-------|
| Token cost per document | 🔴 High (bloated system prompt) | ✅ Minimal (each agent gets only what it needs) |
| Debuggability | 🔴 Hard | ✅ Each agent has clear logs |
| Model selection | 🔴 One model for everything | ✅ GPT-4o for glossary, GPT-4o-mini for bulk |
| Testability | 🔴 Monolithic | ✅ Test each agent independently |
| Crash recovery | 🔴 Restart everything | ✅ Restart from failed stage |

### Where the Agent GENUINELY Earns Its Place

The assessment asks: "somewhere an agent genuinely earns its place over a plain completion."

**The Glossary Agent is the answer:**

A plain completion can translate text. But building a glossary requires:
1. **Read** the document sample
2. **Decide** which terms are domain-specific (judgment call)
3. **Look up** existing translations in cache (tool call)
4. **Resolve** conflicts if cached translation differs from what document context suggests (reasoning)
5. **Store** the final glossary (tool call)

This is a genuine multi-step tool-calling loop that a single completion can't do. The agent needs to iterate: extract → lookup → decide → store → extract more → lookup again.

**Translation itself does NOT need an agent.** It's a pure input→output task. Using an agent for each chunk would add tool-calling overhead × 200 chunks = massive waste.

---

## 6. Recommended Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker Compose                            │
│                                                                  │
│  ┌─────────┐    ┌──────────────┐    ┌────────────┐              │
│  │ React   │    │  Express API │    │  Worker    │              │
│  │ Frontend│───→│  (REST)      │───→│  (BullMQ)  │              │
│  │ :3000   │    │  :4000       │    │            │              │
│  └─────────┘    └──────┬───────┘    └─────┬──────┘              │
│                        │                   │                     │
│                   ┌────┴────┐         ┌────┴────┐               │
│                   │ Core    │←────────│ OpenAI  │               │
│                   │ Service │         │ Agents  │               │
│                   │ Layer   │         │ SDK     │               │
│                   └────┬────┘         └─────────┘               │
│                        │                                         │
│  ┌─────────┐    ┌──────┴───────┐    ┌────────────┐              │
│  │ MCP     │───→│  SQLite DB   │    │  Redis     │              │
│  │ Server  │    │  (jobs, docs)│    │  (queue)   │              │
│  │ (stdio) │    └──────────────┘    └────────────┘              │
│  └─────────┘                                                     │
│                 ┌──────────────┐                                  │
│                 │ File Storage │                                  │
│                 │ (volume)     │                                  │
│                 └──────────────┘                                  │
└──────────────────────────────────────────────────────────────────┘

Key insight: Core Service Layer is shared by BOTH the REST API and the MCP Server.
"Two front doors onto one core" — exactly what the assessment asks for.
```

### Technology Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20 | Assessment says "your choice", JS for full-stack consistency with React |
| Backend framework | Express | Simple, proven, minimal overhead |
| Queue | BullMQ + Redis | Persistent, retry-aware, progress tracking, crash recovery |
| Database | SQLite (better-sqlite3) | Zero-config, runs in container, no separate service, WAL mode handles concurrency |
| PDF parsing | pdf-parse + pdf.js | pdf-parse for text, pdf.js for structure-aware extraction |
| PDF generation | pdf-lib | Pure JS, no native deps, works in Docker without headless Chrome |
| DOCX parsing | mammoth | Robust, extracts text + structure, handles complex docs |
| AI | openai + openai-agents | Required by assessment, clean tool calling |
| MCP | @modelcontextprotocol/sdk | Standard MCP protocol, stdio transport for Claude Code/Cursor |
| Logging | pino | Fast structured JSON logging, correlation IDs |
| Testing | vitest | Fast, native ESM support, compatible with the project |

### Cost Estimate

| Document Size | Chunks | Model | Input Tokens | Output Tokens | Cost |
|--------------|--------|-------|-------------|---------------|------|
| 5 pages | 3-4 | GPT-4o-mini | ~8k | ~8k | $0.003 |
| 20 pages | 12-15 | GPT-4o-mini | ~35k | ~35k | $0.01 |
| 50 pages | 30-35 | GPT-4o-mini | ~90k | ~90k | $0.03 |
| 200 pages | 120-140 | GPT-4o-mini | ~350k | ~350k | $0.10 |
| Glossary extraction | 1 | GPT-4o | ~5k | ~2k | $0.03 |
| Quality validation (per chunk) | 1 | GPT-4o-mini | ~1k | ~0.2k | $0.0002 |

**Estimated total cost per 50-page document: ~$0.07** (glossary + translation + validation)
This is well within budget and allows aggressive testing.

### Docker Compose Structure

```yaml
services:
  frontend:
    build: ./frontend
    ports: ["3000:3000"]
  
  api:
    build: ./backend
    ports: ["4000:4000"]
    depends_on: [redis]
    volumes: [./data:/app/data]
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - REDIS_URL=redis://redis:6379
  
  worker:
    build: ./backend
    command: node worker.js
    depends_on: [redis]
    volumes: [./data:/app/data]
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - REDIS_URL=redis://redis:6379
  
  redis:
    image: redis:7-alpine
    volumes: [redis-data:/data]
    command: redis-server --appendonly yes  # AOF persistence

  mcp:
    build: ./backend
    command: node mcp-server.js
    stdin_open: true
    volumes: [./data:/app/data]

volumes:
  redis-data:
```

---

## Next Steps

1. ✅ Frontend created (Stark-branded React UI)
2. ⬜ Backend: Express API + file upload + core service layer
3. ⬜ Worker: BullMQ translation pipeline
4. ⬜ PDF/DOCX parsing + chunking engine
5. ⬜ OpenAI integration + Glossary Agent
6. ⬜ MCP server
7. ⬜ Crash recovery + error handling
8. ⬜ Tests
9. ⬜ Docker Compose
10. ⬜ Documentation (README, PROMPTS.md, DECISIONS.md)
