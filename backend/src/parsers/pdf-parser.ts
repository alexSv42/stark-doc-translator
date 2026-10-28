import fs from 'node:fs/promises'
import { AppError } from '../lib/errors'
import { createChildLogger } from '../lib/logger'
import type { FormatParser, ParsedDocument, PageContent, ContentBlock } from './index'
import { textToBlocks, estimateTokens } from './index'

const log = createChildLogger('pdf-parser')

const MAX_PAGES = 500

export class PdfParser implements FormatParser {
  readonly supportedFormats = ['pdf']

  canParse(format: string): boolean {
    return format === 'pdf'
  }

  async parse(filePath: string): Promise<ParsedDocument> {
    const startTime = Date.now()
    const buffer = await fs.readFile(filePath)
    const uint8 = new Uint8Array(buffer)

    let pageCount = 0
    let fullText = ''
    const pageTexts: string[] = []

    try {
      const { PDFParse } = await import('pdf-parse') as any
      const parser = new PDFParse(uint8)
      await parser.load()

      const info = await parser.getInfo()
      pageCount = info?.numPages || info?.total || 0

      // Use getText() which returns { pages, text, total }
      const result = await parser.getText()
      if (result && typeof result === 'object' && result.text) {
        fullText = result.text
        pageCount = pageCount || result.total || 1

        // Split text by pages if available
        if (result.pages && Array.isArray(result.pages)) {
          for (const page of result.pages) {
            if (typeof page === 'string') {
              pageTexts.push(page)
            } else if (page && typeof page === 'object' && typeof page.text === 'string') {
              pageTexts.push(page.text)
            } else {
              pageTexts.push(String(page || ''))
            }
          }
        } else {
          // Fallback: treat entire text as single page
          pageTexts.push(fullText)
        }
      } else if (typeof result === 'string') {
        fullText = result
        pageTexts.push(result)
      } else {
        // Fallback: try getPageText for each page
        if (!pageCount) pageCount = 1
        for (let i = 1; i <= Math.min(pageCount, MAX_PAGES); i++) {
          try {
            const pageText = await parser.getPageText(i)
            const text = typeof pageText === 'string' ? pageText : String(pageText || '')
            pageTexts.push(text)
          } catch {
            pageTexts.push('')
          }
        }
        fullText = pageTexts.join('\n\n')
      }

      if (pageCount > MAX_PAGES) {
        parser.destroy()
        throw new AppError('DOCUMENT_TOO_LONG', 422, `This document has ${pageCount} pages (limit: ${MAX_PAGES}).`)
      }

      parser.destroy()
    } catch (err: unknown) {
      if (err instanceof AppError) throw err
      const msg = (err as Error).message || ''
      if (msg.includes('password') || msg.includes('encrypted') || msg.includes('PasswordException')) {
        throw new AppError('PASSWORD_PROTECTED', 422, 'This PDF is password-protected. Remove the password and re-upload.')
      }
      log.warn({ filePath, error: msg }, 'pdf parse failed')
      throw new AppError('CORRUPT_FILE', 422, 'This file is corrupted and cannot be opened.')
    }

    const totalChars = fullText.replace(/\s/g, '').length
    const avgCharsPerPage = totalChars / Math.max(pageCount, 1)

    if (totalChars < 10) {
      if (avgCharsPerPage < 100) {
        throw new AppError('SCANNED_PDF_DETECTED', 422, 'This PDF contains scanned images instead of extractable text.')
      }
      throw new AppError('NO_EXTRACTABLE_TEXT', 422, 'No text could be extracted from this file.')
    }

    if (avgCharsPerPage < 100) {
      throw new AppError('SCANNED_PDF_DETECTED', 422, 'This PDF contains scanned images instead of extractable text.')
    }

    const pages: PageContent[] = pageTexts.map((text, i) => ({
      pageNumber: i + 1,
      text: text.trim(),
    })).filter((p) => p.text.length > 0)

    // If we got all text in one chunk, split into blocks from that
    const blocks: ContentBlock[] = []
    for (const page of pages) {
      const pageBlocks = textToBlocks(page.text, page.pageNumber)
      blocks.push(...pageBlocks)
    }

    const parseDurationMs = Date.now() - startTime
    log.info({ filePath, textLength: fullText.length, blockCount: blocks.length, pageCount, parseDurationMs }, 'pdf parsed')

    return {
      text: fullText,
      pages,
      blocks,
      metadata: {
        pageCount,
        estimatedTokens: estimateTokens(fullText),
        isScanned: false,
        detectedLanguage: null,
        parseDurationMs,
      },
    }
  }
}
