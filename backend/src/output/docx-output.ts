import fs from 'node:fs/promises'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType,
} from 'docx'
import { createChildLogger } from '../lib/logger'
import type { OutputGenerator, TranslatedChunk, OutputResult } from './index'

const log = createChildLogger('docx-output')

export class DocxOutputGenerator implements OutputGenerator {
  readonly format = 'docx'

  async generate(
    chunks: TranslatedChunk[],
    outputPath: string,
    metadata: { title: string; sourceLanguage: string; targetLanguage: string },
  ): Promise<OutputResult> {
    const start = Date.now()
    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)

    const children: (Paragraph | Table)[] = []

    for (const chunk of sorted) {
      const text = chunk.translatedText
      if (!text) continue

      const blockTypes = chunk.metadata?.blockTypes || []

      // Split by double newlines to get paragraphs/blocks
      const blocks = text.split(/\n\n+/)

      for (const block of blocks) {
        const trimmed = block.trim()
        if (!trimmed) continue

        // Detect block type from text structure
        if (this.isMarkdownHeading(trimmed)) {
          children.push(this.buildHeading(trimmed))
        } else if (this.isMarkdownTable(trimmed)) {
          const table = this.buildTable(trimmed)
          if (table) children.push(table)
        } else if (this.isMarkdownList(trimmed)) {
          children.push(...this.buildList(trimmed))
        } else if (this.isCodeBlock(trimmed) || (blockTypes.includes('code') && chunk.metadata?.hasCode)) {
          children.push(this.buildCodeBlock(trimmed))
        } else {
          children.push(...this.buildParagraphs(trimmed))
        }
      }
    }

    if (children.length === 0) {
      children.push(new Paragraph({ text: '(No translated content)' }))
    }

    const doc = new Document({
      title: metadata.title,
      description: `Translated from ${metadata.sourceLanguage} to ${metadata.targetLanguage}`,
      sections: [{ children }],
    })

    const buffer = await Packer.toBuffer(doc)
    await fs.writeFile(outputPath, buffer)

    const assembleDurationMs = Date.now() - start
    log.info({ outputPath, chunks: chunks.length, assembleDurationMs }, 'docx output generated')

    return { outputPath, assembleDurationMs }
  }

  private isMarkdownHeading(text: string): boolean {
    return /^#{1,6}\s/.test(text)
  }

  private isMarkdownTable(text: string): boolean {
    const lines = text.split('\n').filter((l) => l.trim())
    return lines.length >= 2 && lines.every((l) => l.trim().startsWith('|') && l.trim().endsWith('|'))
  }

  private isMarkdownList(text: string): boolean {
    const lines = text.split('\n').filter((l) => l.trim())
    return lines.length > 0 && lines.every((l) => /^\s*[-*+]\s|^\s*\d+[.)]\s/.test(l))
  }

  private isCodeBlock(text: string): boolean {
    return text.startsWith('```') && text.endsWith('```')
  }

  private buildHeading(text: string): Paragraph {
    const match = text.match(/^(#{1,6})\s+(.*)/)
    if (!match) return new Paragraph({ text })

    const level = match[1].length
    const content = match[2]

    const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
      4: HeadingLevel.HEADING_4,
      5: HeadingLevel.HEADING_5,
      6: HeadingLevel.HEADING_6,
    }

    return new Paragraph({
      heading: headingMap[level] || HeadingLevel.HEADING_3,
      children: this.parseInlineFormatting(content),
    })
  }

  private buildTable(text: string): Table | null {
    const lines = text.split('\n').filter((l) => l.trim())
    // Filter out separator rows (|---|---|)
    const dataLines = lines.filter((l) => !/^\|[\s-:|]+\|$/.test(l.trim()))

    if (dataLines.length === 0) return null

    const rows = dataLines.map((line, rowIdx) => {
      const cells = line.split('|').filter((c, i, arr) => i > 0 && i < arr.length - 1)
      return new TableRow({
        children: cells.map((cellText) =>
          new TableCell({
            width: { size: Math.floor(100 / Math.max(cells.length, 1)), type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: cellText.trim(),
                    bold: rowIdx === 0,
                  }),
                ],
              }),
            ],
          }),
        ),
      })
    })

    if (rows.length === 0) return null

    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    })
  }

  private buildList(text: string): Paragraph[] {
    return text.split('\n').filter((l) => l.trim()).map((line) => {
      const content = line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '')
      return new Paragraph({
        bullet: { level: 0 },
        children: this.parseInlineFormatting(content),
      })
    })
  }

  private buildCodeBlock(text: string): Paragraph {
    const content = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
    return new Paragraph({
      children: [
        new TextRun({
          text: content,
          font: 'Courier New',
          size: 18,
          color: '555555',
        }),
      ],
      spacing: { before: 120, after: 120 },
      shading: { fill: 'F5F5F5' },
    })
  }

  private buildParagraphs(text: string): Paragraph[] {
    const lines = text.split('\n')
    return lines.filter((l) => l.trim()).map((line) =>
      new Paragraph({
        children: this.parseInlineFormatting(line),
        spacing: { after: 120 },
      }),
    )
  }

  private parseInlineFormatting(text: string): TextRun[] {
    const runs: TextRun[] = []
    // Simple bold/italic detection: **bold**, *italic*, ***bold-italic***
    const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      if (match[2]) {
        runs.push(new TextRun({ text: match[2], bold: true, italics: true }))
      } else if (match[3]) {
        runs.push(new TextRun({ text: match[3], bold: true }))
      } else if (match[4]) {
        runs.push(new TextRun({ text: match[4], italics: true }))
      } else if (match[5]) {
        runs.push(new TextRun({ text: match[5], font: 'Courier New', size: 20 }))
      } else if (match[6]) {
        runs.push(new TextRun({ text: match[6] }))
      }
    }

    if (runs.length === 0) {
      runs.push(new TextRun({ text }))
    }

    return runs
  }
}
