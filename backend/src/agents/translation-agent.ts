import { Injectable } from '@nestjs/common'
import { Agent, run, tool } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { TranslationCacheService } from '../translation/cache.service'
import { glossaries, translationCache } from '../db/schema'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'
import { calculateCost } from '../translation/provider'
import type { GlossaryEntry, TranslationResult } from '../translation/provider'

const log = createChildLogger('translation-agent')

const MODEL = 'gpt-4o-mini'
const MAX_SAMPLE_CHARS = 5000

/**
 * Unified TranslationAgent — owns the full linguistic pipeline:
 *
 *   Phase 1 (once per document): Glossary extraction
 *     Agent with tools: search_translation_cache, save_glossary_entry
 *
 *   Phase 2 (per chunk): Translation
 *     FAST PATH (default): Single OpenAI chat completion with glossary inlined in prompt.
 *       1 API call per chunk instead of 3-5. ~8s vs ~80s.
 *     COMPLEX PATH (tables/code): Agent with validate_structure tool.
 *
 * In mock mode (no API key): returns prefixed text, zero tokens.
 */
@Injectable()
export class TranslationAgentService {
  private glossaryCache = new Map<string, GlossaryEntry[]>()
  private openai: OpenAI | null = null

  constructor(
    private db: DatabaseService,
    private cache: TranslationCacheService,
  ) {
    if (config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey })
    }
  }

  // ── Phase 1: Glossary Extraction ───────────────────────────────────────

  async extractGlossary(
    documentText: string,
    documentId: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<GlossaryEntry[]> {
    if (!config.openaiApiKey) {
      log.warn('no OpenAI API key — skipping glossary extraction')
      return []
    }

    const sample = documentText.slice(0, MAX_SAMPLE_CHARS)
    const entries: GlossaryEntry[] = []

    const searchCacheTool = tool({
      name: 'search_translation_cache',
      description: 'Look up existing translations for terms in the cache.',
      parameters: z.object({
        terms: z.array(z.string()).describe('Array of source-language terms to look up'),
      }),
      execute: async ({ terms }) => {
        const results: Record<string, string | null> = {}
        const drizzleDb = this.db.getDb()

        for (const term of terms) {
          const hash = this.cache.contentHash(term, sourceLang, targetLang)
          const [cached] = await drizzleDb
            .select({ translatedText: translationCache.translatedText })
            .from(translationCache)
            .where(
              and(
                eq(translationCache.contentHash, hash),
                eq(translationCache.sourceLanguage, sourceLang),
                eq(translationCache.targetLanguage, targetLang),
              ),
            )
          results[term] = cached?.translatedText || null
        }
        return JSON.stringify(results)
      },
    })

    const saveGlossaryTool = tool({
      name: 'save_glossary_entry',
      description: 'Save a term translation decision to the glossary for this document.',
      parameters: z.object({
        source: z.string().describe('The source-language term'),
        target: z.string().describe('The target-language translation'),
        type: z.enum(['brand', 'technical', 'proper_noun', 'domain_term', 'keep_original']),
        reasoning: z.string().describe('Brief explanation of why this translation was chosen'),
      }),
      execute: async ({ source, target, type, reasoning }) => {
        entries.push({ source, target, type })
        return `Saved: ${source} → ${target} (${type})`
      },
    })

    const glossaryAgent = new Agent({
      name: 'TranslationAgent-Glossary',
      model: MODEL,
      instructions: `You extract domain-specific terminology from a document sample for translation from ${sourceLang} to ${targetLang}.

For each domain-specific term you find:
1. First call search_translation_cache with a batch of terms to check for existing translations
2. For each term, decide whether to use the cached translation or provide a new one
3. Call save_glossary_entry for each term with your decision and reasoning

Guidelines:
- Focus on: brand names, technical terms, proper nouns, domain-specific vocabulary
- Skip common everyday words
- 10-30 entries is typical for a document
- For brand names that should stay in the original language, use type "keep_original"`,
      tools: [searchCacheTool, saveGlossaryTool],
    })

    try {
      await run(glossaryAgent, `Extract terminology from this document sample:\n\n${sample}`)

      if (entries.length > 0) {
        const drizzleDb = this.db.getDb()
        await drizzleDb.insert(glossaries).values({
          documentId,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          terms: entries,
        })
        log.info({ documentId, entryCount: entries.length }, 'glossary extracted and saved')
      }

      this.glossaryCache.set(documentId, entries)
    } catch (err) {
      log.warn({ err: (err as Error).message, documentId }, 'glossary extraction failed — continuing without')
    }

    return entries
  }

  // ── Phase 2: Chunk Translation ─────────────────────────────────────────

  async translateChunk(
    text: string,
    sourceLang: string,
    targetLang: string,
    documentId: string,
    chunkIndex: number,
    previousContext: string,
    hasTable: boolean,
  ): Promise<TranslationResult> {
    if (!config.openaiApiKey) {
      return this.mockTranslate(text, targetLang)
    }

    // Check translation cache first
    const cached = await this.cache.lookup(text, sourceLang, targetLang)
    if (cached) {
      log.debug({ documentId, chunkIndex }, 'translation served from cache')
      return cached
    }

    // Load glossary for this document
    const glossary = await this.loadGlossary(documentId, sourceLang, targetLang)

    // FAST PATH: single completion call with glossary inlined (no tool overhead)
    // Used for ~95% of chunks. 1 API call instead of 3-5.
    if (!hasTable) {
      return this.translateDirect(text, sourceLang, targetLang, documentId, chunkIndex, previousContext, glossary)
    }

    // COMPLEX PATH: agent with validate_structure tool (for tables/code)
    return this.translateWithAgent(text, sourceLang, targetLang, documentId, chunkIndex, previousContext, glossary, hasTable)
  }

  /**
   * Fast path: single chat completion with glossary inlined in the system prompt.
   * Eliminates tool-call round-trips. ~5-10s vs ~60-80s.
   */
  private async translateDirect(
    text: string,
    sourceLang: string,
    targetLang: string,
    documentId: string,
    chunkIndex: number,
    previousContext: string,
    glossary: GlossaryEntry[],
  ): Promise<TranslationResult> {
    const start = Date.now()

    let glossaryBlock = ''
    if (glossary.length > 0) {
      const entries = glossary.map((g) => `  ${g.source} → ${g.target} (${g.type})`).join('\n')
      glossaryBlock = `\nGlossary — use these translations consistently:\n${entries}\n`
    }

    let contextLine = ''
    if (previousContext) {
      contextLine = `\nFor continuity, the previous chunk ended with: "${previousContext}"`
    }

    const systemPrompt = `You are a professional document translator. Translate the user's text from ${sourceLang} to ${targetLang}.
${glossaryBlock}
RULES:
- Output ONLY the translated text — no explanations, no wrapping, no commentary.
- Translate ALL text, even if it looks like a placeholder or sample.
- Preserve markdown formatting exactly (headings, lists, bold, line breaks).
- Do NOT translate: code blocks, URLs, email addresses.
- For glossary terms marked "keep_original", keep them in ${sourceLang}.${contextLine}`

    try {
      const response = await this.openai!.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      })

      const durationMs = Date.now() - start
      const translatedText = response.choices[0]?.message?.content?.trim() || text
      const inputTokens = response.usage?.prompt_tokens || Math.ceil((text.length + systemPrompt.length) / 4)
      const outputTokens = response.usage?.completion_tokens || Math.ceil(translatedText.length / 4)
      const costUsd = calculateCost(MODEL, inputTokens, outputTokens)

      await this.cache.store(text, sourceLang, targetLang, translatedText, MODEL)

      log.info({ documentId, chunkIndex, inputTokens, outputTokens, costUsd, durationMs, mode: 'direct' }, 'chunk translated')

      return { translatedText, inputTokens, outputTokens, costUsd, model: MODEL, durationMs, fromCache: false }
    } catch (err: unknown) {
      return this.handleTranslationError(err, Date.now() - start)
    }
  }

  /**
   * Complex path: agent with validate_structure tool.
   * Used for chunks containing tables or code that need structural validation.
   */
  private async translateWithAgent(
    text: string,
    sourceLang: string,
    targetLang: string,
    documentId: string,
    chunkIndex: number,
    previousContext: string,
    glossary: GlossaryEntry[],
    hasTable: boolean,
  ): Promise<TranslationResult> {
    const start = Date.now()

    let glossaryBlock = ''
    if (glossary.length > 0) {
      const entries = glossary.map((g) => `  ${g.source} → ${g.target} (${g.type})`).join('\n')
      glossaryBlock = `\nGlossary — use these translations consistently:\n${entries}\n`
    }

    let contextLine = previousContext ? `\nFor continuity, the previous chunk ended with: "${previousContext}"` : ''
    let tableInstruction = hasTable
      ? '\n- This chunk contains a markdown table. Translate cell contents but preserve table structure (pipes/dashes) exactly.'
      : ''

    const validateStructureTool = tool({
      name: 'validate_structure',
      description: 'Validate translated output preserves markdown formatting of the original.',
      parameters: z.object({
        original: z.string().describe('The original source text'),
        translated: z.string().describe('The translated text to validate'),
      }),
      execute: async ({ original, translated }) => {
        const issues: string[] = []
        const origPipes = (original.match(/\|/g) || []).length
        const transPipes = (translated.match(/\|/g) || []).length
        if (origPipes > 0 && Math.abs(origPipes - transPipes) > 2)
          issues.push(`Table pipes: original ${origPipes}, translated ${transPipes}`)
        const origHeadings = (original.match(/^#{1,6}\s/gm) || []).length
        const transHeadings = (translated.match(/^#{1,6}\s/gm) || []).length
        if (origHeadings !== transHeadings)
          issues.push(`Headings: original ${origHeadings}, translated ${transHeadings}`)
        if (issues.length === 0) return 'Validation passed.'
        return `Issues:\n${issues.join('\n')}\nPlease fix these.`
      },
    })

    const translationAgent = new Agent({
      name: 'TranslationAgent',
      model: MODEL,
      instructions: `You are a professional document translator. Translate text from ${sourceLang} to ${targetLang}.
${glossaryBlock}
CRITICAL: Output ONLY the translated text. Never refuse. Never explain.

After translating, call validate_structure to verify formatting is preserved.

Formatting rules:
- Preserve markdown structure exactly (tables, lists, bold, headings, line breaks)
- Do NOT translate: code blocks, URLs, email addresses
- For glossary "keep_original" terms, keep in ${sourceLang}${contextLine}${tableInstruction}`,
      tools: [validateStructureTool],
    })

    try {
      const result = await run(translationAgent, text)
      const durationMs = Date.now() - start

      let translatedText = ''
      if (typeof result.finalOutput === 'string') {
        translatedText = result.finalOutput
      } else if (result.finalOutput != null) {
        translatedText = String(result.finalOutput)
      }
      if (!translatedText.trim()) translatedText = text

      const inputTokens = Math.ceil((text.length + 500) / 4)
      const outputTokens = Math.ceil(translatedText.length / 4)
      const costUsd = calculateCost(MODEL, inputTokens, outputTokens)

      await this.cache.store(text, sourceLang, targetLang, translatedText, MODEL)
      log.info({ documentId, chunkIndex, inputTokens, outputTokens, costUsd, durationMs, mode: 'agent' }, 'chunk translated')

      return { translatedText, inputTokens, outputTokens, costUsd, model: MODEL, durationMs, fromCache: false }
    } catch (err: unknown) {
      return this.handleTranslationError(err, Date.now() - start)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private handleTranslationError(err: unknown, durationMs: number): never {
    const error = err as Error & { status?: number; code?: string }

    if (error.status === 401 || error.message?.includes('401'))
      throw Object.assign(new Error('Invalid OpenAI API key'), { code: 'AUTH_FAILED' })
    if (error.status === 429 || error.message?.includes('429'))
      throw Object.assign(new Error('OpenAI rate limit'), { code: 'RATE_LIMITED' })
    if (error.status && error.status >= 500)
      throw Object.assign(new Error(`OpenAI server error: ${error.status}`), { code: 'PROVIDER_ERROR' })
    if (error.message?.includes('content_filter'))
      throw Object.assign(new Error('Content filtered'), { code: 'CONTENT_FILTERED' })
    if (durationMs > 120_000)
      throw Object.assign(new Error('OpenAI timeout'), { code: 'PROVIDER_TIMEOUT' })

    throw Object.assign(new Error(`Translation error: ${error.message}`), { code: 'PROVIDER_ERROR' })
  }

  async loadGlossary(
    documentId: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<GlossaryEntry[]> {
    const cached = this.glossaryCache.get(documentId)
    if (cached) return cached

    try {
      const drizzleDb = this.db.getDb()
      const [row] = await drizzleDb
        .select({ terms: glossaries.terms })
        .from(glossaries)
        .where(
          and(
            eq(glossaries.documentId, documentId),
            eq(glossaries.sourceLanguage, sourceLang),
            eq(glossaries.targetLanguage, targetLang),
          ),
        )

      const entries = (row?.terms as GlossaryEntry[] | undefined) || []
      this.glossaryCache.set(documentId, entries)
      return entries
    } catch (err) {
      log.warn({ documentId, err: (err as Error).message }, 'failed to load glossary from DB')
      return []
    }
  }

  private mockTranslate(text: string, targetLang: string): TranslationResult {
    const translatedText = `[${targetLang}] ${text}`
    const inputTokens = Math.ceil(text.length / 4)
    const outputTokens = Math.ceil(translatedText.length / 4)

    return {
      translatedText,
      inputTokens,
      outputTokens,
      costUsd: (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60,
      model: 'mock',
      durationMs: 50,
      fromCache: false,
    }
  }
}
