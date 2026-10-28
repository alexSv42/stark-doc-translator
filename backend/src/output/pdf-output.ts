import fs from 'node:fs/promises'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { createChildLogger } from '../lib/logger'
import type { OutputGenerator, TranslatedChunk, OutputResult } from './index'

const log = createChildLogger('pdf-output')

const MARGIN_LEFT = 50
const MARGIN_RIGHT = 50
const MARGIN_TOP = 60
const MARGIN_BOTTOM = 50
const HEADING_SIZE = 16
const BODY_SIZE = 11
const LINE_HEIGHT_FACTOR = 1.4
const PAGE_WIDTH = 595.28   // A4
const PAGE_HEIGHT = 841.89  // A4

const CJK_LANGUAGES = new Set(['ja', 'ko', 'zh'])

export class PdfOutputGenerator implements OutputGenerator {
  readonly format = 'pdf'

  async generate(
    chunks: TranslatedChunk[],
    outputPath: string,
    metadata: { title: string; sourceLanguage: string; targetLanguage: string },
  ): Promise<OutputResult> {
    const start = Date.now()
    const pdfDoc = await PDFDocument.create()

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    pdfDoc.setTitle(metadata.title)
    pdfDoc.setLanguage(metadata.targetLanguage)
    pdfDoc.setProducer('Stark Document Translator')

    const usableWidth = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let y = PAGE_HEIGHT - MARGIN_TOP

    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)

    const isCjk = CJK_LANGUAGES.has(metadata.targetLanguage)

    for (const chunk of sorted) {
      const text = chunk.translatedText
      if (!text) continue

      const blockTypes = chunk.metadata?.blockTypes || []
      const isHeading = blockTypes.includes('heading')
      const isCode = blockTypes.includes('code') && chunk.metadata?.hasCode

      const fontSize = isHeading ? HEADING_SIZE : BODY_SIZE
      const activeFont = isHeading ? fontBold : font
      const lineHeight = fontSize * LINE_HEIGHT_FACTOR

      const lines = this.wrapText(text, activeFont, fontSize, usableWidth, isCjk)

      for (const line of lines) {
        if (y - lineHeight < MARGIN_BOTTOM) {
          page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
          y = PAGE_HEIGHT - MARGIN_TOP
        }

        try {
          page.drawText(line, {
            x: MARGIN_LEFT,
            y,
            size: fontSize,
            font: isCode ? font : activeFont,
            color: isCode ? rgb(0.3, 0.3, 0.3) : rgb(0, 0, 0),
          })
        } catch {
          // Character not in font (e.g. CJK with Helvetica) — skip line
          page.drawText('[text requires CJK-capable viewer]', {
            x: MARGIN_LEFT,
            y,
            size: fontSize,
            font,
            color: rgb(0.6, 0.6, 0.6),
          })
        }

        y -= lineHeight
      }

      // Paragraph spacing
      y -= lineHeight * 0.5
    }

    if (isCjk) {
      // Add CJK notice on the last page
      const noticeFont = font
      const noticeSize = 9
      if (y - noticeSize * 2 < MARGIN_BOTTOM) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
        y = PAGE_HEIGHT - MARGIN_TOP
      }
      y -= noticeSize * 2
      page.drawText(
        'Note: CJK characters may not render correctly. Open in a CJK-capable PDF viewer.',
        { x: MARGIN_LEFT, y, size: noticeSize, font: noticeFont, color: rgb(0.5, 0.5, 0.5) },
      )
    }

    const pdfBytes = await pdfDoc.save()
    await fs.writeFile(outputPath, pdfBytes)

    const assembleDurationMs = Date.now() - start
    log.info({ outputPath, chunks: chunks.length, pages: pdfDoc.getPageCount(), assembleDurationMs }, 'pdf output generated')

    return { outputPath, assembleDurationMs }
  }

  private wrapText(
    text: string,
    font: any,
    fontSize: number,
    maxWidth: number,
    isCjk: boolean,
  ): string[] {
    const result: string[] = []
    const paragraphs = text.split('\n')

    for (const para of paragraphs) {
      if (para.trim() === '') {
        result.push('')
        continue
      }

      if (isCjk) {
        // CJK: wrap by character since spaces are rare
        result.push(...this.wrapByCharWidth(para, font, fontSize, maxWidth))
      } else {
        result.push(...this.wrapByWord(para, font, fontSize, maxWidth))
      }
    }

    return result
  }

  private wrapByWord(text: string, font: any, fontSize: number, maxWidth: number): string[] {
    const words = text.split(/\s+/)
    const lines: string[] = []
    let currentLine = ''

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word
      let width: number
      try {
        width = font.widthOfTextAtSize(testLine, fontSize)
      } catch {
        width = testLine.length * fontSize * 0.5
      }

      if (width > maxWidth && currentLine) {
        lines.push(currentLine)
        currentLine = word
      } else {
        currentLine = testLine
      }
    }

    if (currentLine) lines.push(currentLine)
    return lines.length > 0 ? lines : ['']
  }

  private wrapByCharWidth(text: string, font: any, fontSize: number, maxWidth: number): string[] {
    const lines: string[] = []
    let currentLine = ''
    const avgCharWidth = fontSize * 0.6

    for (const char of text) {
      const testLine = currentLine + char
      const estimatedWidth = testLine.length * avgCharWidth

      if (estimatedWidth > maxWidth && currentLine) {
        lines.push(currentLine)
        currentLine = char
      } else {
        currentLine = testLine
      }
    }

    if (currentLine) lines.push(currentLine)
    return lines.length > 0 ? lines : ['']
  }
}
