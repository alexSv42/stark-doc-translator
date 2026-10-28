import fs from 'node:fs/promises'
import { AppError } from '../lib/errors'
import { createChildLogger } from '../lib/logger'
import type { FormatParser, ParsedDocument, ContentBlock } from './index'
import { textToBlocks, estimateTokens } from './index'

const log = createChildLogger('markdown-parser')

export class MarkdownParser implements FormatParser {
  readonly supportedFormats = ['md']

  canParse(format: string): boolean {
    return format === 'md'
  }

  async parse(filePath: string): Promise<ParsedDocument> {
    const startTime = Date.now()

    let text: string
    try {
      text = await fs.readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      const msg = (err as Error).message || ''
      log.warn({ filePath, error: msg }, 'markdown read failed')
      throw new AppError('CORRUPT_FILE', 422, 'This file is corrupted and cannot be opened.')
    }

    if (text.replace(/\s/g, '').length < 10) {
      throw new AppError('NO_EXTRACTABLE_TEXT', 422, 'No text could be extracted from this file.')
    }

    const blocks: ContentBlock[] = textToBlocks(text, 1)
    const parseDurationMs = Date.now() - startTime

    log.info({ filePath, textLength: text.length, blockCount: blocks.length, parseDurationMs }, 'markdown parsed')

    return {
      text,
      pages: [{ pageNumber: 1, text }],
      blocks,
      metadata: {
        pageCount: 1,
        estimatedTokens: estimateTokens(text),
        isScanned: false,
        detectedLanguage: null,
        parseDurationMs,
      },
    }
  }
}
