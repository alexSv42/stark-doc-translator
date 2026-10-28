export interface GlossaryEntry {
  source: string
  target: string
  type: 'brand' | 'technical' | 'proper_noun' | 'domain_term' | 'keep_original'
}

export interface TranslationContext {
  glossary: GlossaryEntry[]
  previousContext: string
  documentTitle: string | null
  chunkIndex: number
  totalChunks: number
  hasTable: boolean
}

export interface TranslationResult {
  translatedText: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  model: string
  durationMs: number
  fromCache: boolean
}

export interface TranslationProvider {
  translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    context: TranslationContext,
  ): Promise<TranslationResult>
}

export function buildTranslationPrompt(
  sourceLang: string,
  targetLang: string,
  context: TranslationContext,
): string {
  const glossaryLines = context.glossary
    .map((g) => `  ${g.source} → ${g.target}`)
    .join('\n')

  let prompt = `You are a professional document translator.
Translate from ${sourceLang} to ${targetLang}.

Rules:
- Translate all text accurately and naturally.
- Preserve markdown formatting (tables, lists, bold, headings).
- Do NOT translate: code blocks, URLs, email addresses, brand names marked "keep_original".`

  if (glossaryLines) {
    prompt += `\n- Glossary (use these translations consistently):\n${glossaryLines}`
  }

  if (context.previousContext) {
    prompt += `\n- For context, the previous chunk ended with:\n  "${context.previousContext}"`
  }

  prompt += `\n- This is chunk ${context.chunkIndex + 1} of ${context.totalChunks}.`

  if (context.hasTable) {
    prompt += '\n- This chunk contains a markdown table. Translate cell contents but preserve table structure (pipes/dashes) exactly.'
  }

  return prompt
}

// gpt-4o-mini pricing per 1M tokens (as of 2024)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] || PRICING['gpt-4o-mini']
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
}
