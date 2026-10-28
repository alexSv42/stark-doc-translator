import fs from 'node:fs/promises'
import { createChildLogger } from '../lib/logger'
import type { OutputGenerator, TranslatedChunk, OutputResult } from './index'

const log = createChildLogger('markdown-output')

export class MarkdownOutputGenerator implements OutputGenerator {
  readonly format = 'md'

  async generate(
    chunks: TranslatedChunk[],
    outputPath: string,
    metadata: { title: string; sourceLanguage: string; targetLanguage: string },
  ): Promise<OutputResult> {
    const start = Date.now()

    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
    const content = sorted.map((c) => c.translatedText).join('\n\n')

    await fs.writeFile(outputPath, content, 'utf-8')

    const assembleDurationMs = Date.now() - start
    log.info({ outputPath, chunks: chunks.length, assembleDurationMs }, 'markdown output generated')

    return { outputPath, assembleDurationMs }
  }
}
