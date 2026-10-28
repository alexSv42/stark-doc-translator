import fs from 'node:fs/promises'
import mammoth from 'mammoth'
import { AppError } from '../lib/errors'
import { createChildLogger } from '../lib/logger'
import type { FormatParser, ParsedDocument, ContentBlock } from './index'
import { textToBlocks, estimateTokens } from './index'

const mammothExt = mammoth as typeof mammoth & {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string; messages: { message: string }[] }>
}

const log = createChildLogger('docx-parser')

export class DocxParser implements FormatParser {
  readonly supportedFormats = ['docx']

  canParse(format: string): boolean {
    return format === 'docx'
  }

  async parse(filePath: string): Promise<ParsedDocument> {
    const startTime = Date.now()
    const buffer = await fs.readFile(filePath)

    let result: { value: string; messages: { message: string }[] }
    try {
      result = await mammothExt.convertToMarkdown({ buffer })
    } catch (err: unknown) {
      const msg = (err as Error).message || ''
      log.warn({ filePath, error: msg }, 'docx parse failed')
      throw new AppError('CORRUPT_FILE', 422, 'This file is corrupted and cannot be opened.')
    }

    const text = result.value || ''
    if (text.replace(/\s/g, '').length < 10) {
      throw new AppError('NO_EXTRACTABLE_TEXT', 422, 'No text could be extracted from this file.')
    }

    const blocks: ContentBlock[] = textToBlocks(text, 1)
    const estimatedPages = Math.max(1, Math.ceil(text.length / 3000))
    const parseDurationMs = Date.now() - startTime

    log.info({ filePath, textLength: text.length, blockCount: blocks.length, parseDurationMs }, 'docx parsed')

    if (result.messages.length > 0) {
      log.debug({ messages: result.messages.map((m: { message: string }) => m.message) }, 'mammoth warnings')
    }

    return {
      text,
      pages: [{ pageNumber: 1, text }],
      blocks,
      metadata: {
        pageCount: estimatedPages,
        estimatedTokens: estimateTokens(text),
        isScanned: false,
        detectedLanguage: null,
        parseDurationMs,
      },
    }
  }
}
