import { Injectable } from '@nestjs/common'
import type { TranslationProvider, TranslationContext, TranslationResult } from './provider'

@Injectable()
export class MockProvider implements TranslationProvider {
  public callLog: Array<{ text: string; sourceLang: string; targetLang: string; context: TranslationContext }> = []

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    context: TranslationContext,
  ): Promise<TranslationResult> {
    this.callLog.push({ text, sourceLang, targetLang, context })

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
