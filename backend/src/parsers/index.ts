import { AppError } from '../lib/errors'

export interface PageContent {
  pageNumber: number
  text: string
}

export interface ContentBlock {
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'code' | 'image_placeholder'
  text: string
  pageNumber: number
  translatable: boolean
}

export interface DocumentMetadata {
  pageCount: number
  estimatedTokens: number
  isScanned: boolean
  detectedLanguage: string | null
  parseDurationMs: number
}

export interface ParsedDocument {
  text: string
  pages: PageContent[]
  blocks: ContentBlock[]
  metadata: DocumentMetadata
}

export interface FormatParser {
  readonly supportedFormats: string[]
  canParse(format: string): boolean
  parse(filePath: string): Promise<ParsedDocument>
}

let _parsers: FormatParser[] | null = null

async function loadParsers(): Promise<FormatParser[]> {
  if (!_parsers) {
    const [{ PdfParser }, { DocxParser }, { MarkdownParser }] = await Promise.all([
      import('./pdf-parser'),
      import('./docx-parser'),
      import('./markdown-parser'),
    ])
    _parsers = [new PdfParser(), new DocxParser(), new MarkdownParser()]
  }
  return _parsers
}

export async function getParser(format: string): Promise<FormatParser> {
  const parsers = await loadParsers()
  const parser = parsers.find((p) => p.canParse(format))
  if (!parser) {
    throw new AppError('UNSUPPORTED_FORMAT', 415, `'${format}' is not supported. Accepted: PDF, DOCX, MD.`)
  }
  return parser
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function textToBlocks(text: string, pageNumber: number = 1): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const lines = text.split('\n')
  let current = ''
  let currentType: ContentBlock['type'] = 'paragraph'
  let inCodeBlock = false
  let codeContent = ''

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) {
      blocks.push({ type: currentType, text: trimmed, pageNumber, translatable: currentType !== 'code' })
    }
    current = ''
    currentType = 'paragraph'
  }

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        codeContent += line + '\n'
        blocks.push({ type: 'code', text: codeContent.trim(), pageNumber, translatable: false })
        codeContent = ''
        inCodeBlock = false
        continue
      } else {
        flush()
        inCodeBlock = true
        codeContent = line + '\n'
        continue
      }
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    if (/^#{1,6}\s/.test(line)) {
      flush()
      blocks.push({ type: 'heading', text: line.trim(), pageNumber, translatable: true })
      continue
    }

    if (/^\|.*\|/.test(line.trim())) {
      if (currentType !== 'table') {
        flush()
        currentType = 'table'
      }
      current += line + '\n'
      continue
    }

    if (/^[\s]*[-*+]\s|^[\s]*\d+[.)]\s/.test(line)) {
      if (currentType !== 'list') {
        flush()
        currentType = 'list'
      }
      current += line + '\n'
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    if (currentType !== 'paragraph') {
      flush()
    }

    current += line + '\n'
  }

  if (inCodeBlock && codeContent.trim()) {
    blocks.push({ type: 'code', text: codeContent.trim(), pageNumber, translatable: false })
  } else {
    flush()
  }

  return blocks
}
