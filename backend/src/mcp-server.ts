import 'reflect-metadata'
import fs from 'node:fs/promises'
import path from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AppModule } from './app.module'
import { DocumentsService } from './documents/documents.service'
import { TranslationService } from './core/translation-service'
import { SUPPORTED_LANGUAGES, SUPPORTED_EXTENSIONS } from './types/index'
import { createChildLogger } from './lib/logger'
import { runMigrations } from './db/migrate'

const log = createChildLogger('mcp')

const TOOLS = [
  {
    name: 'translate_document',
    description: 'Read a file from disk and translate it to a target language. Returns a document ID to track progress.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to translate (PDF, DOCX, or MD)' },
        target_language: { type: 'string', description: 'Target language code (e.g. "es", "de", "fr"). Use list_supported_languages to see all options.' },
        source_language: { type: 'string', description: 'Source language code (optional, auto-detected if omitted)' },
      },
      required: ['file_path', 'target_language'],
    },
  },
  {
    name: 'get_translation_status',
    description: 'Check the progress of a translation job. Returns status, progress percentage, and any errors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'The document ID returned by translate_document' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'download_translation',
    description: 'Get the translated file path once translation is complete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'The document ID' },
        output_directory: { type: 'string', description: 'Directory to copy the output file to (optional, returns storage path if omitted)' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'list_supported_languages',
    description: 'List all supported translation languages with their codes.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_document_cost',
    description: 'See cost breakdown for a translation including total cost, tokens used, and model.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'The document ID' },
      },
      required: ['document_id'],
    },
  },
]

async function main() {
  await runMigrations()

  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  })

  const documentsService = appContext.get(DocumentsService)
  const translationService = appContext.get(TranslationService)

  const server = new Server(
    { name: 'stark-translator', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      switch (name) {
        case 'translate_document':
          return await handleTranslateDocument(args, documentsService, translationService)
        case 'get_translation_status':
          return await handleGetStatus(args, documentsService)
        case 'download_translation':
          return await handleDownloadTranslation(args, documentsService)
        case 'list_supported_languages':
          return handleListLanguages()
        case 'get_document_cost':
          return await handleGetCost(args, documentsService)
        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ tool: name, err: msg }, 'tool error')
      return {
        content: [{ type: 'text' as const, text: msg }],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info('MCP server started on stdio')

  process.on('SIGTERM', async () => {
    await server.close()
    await appContext.close()
    process.exit(0)
  })
}

async function handleTranslateDocument(
  args: any,
  documentsService: DocumentsService,
  translationService: TranslationService,
) {
  const filePath = args?.file_path as string
  const targetLang = args?.target_language as string
  const sourceLang = args?.source_language as string | undefined

  if (!filePath) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: file_path' }], isError: true }
  }
  if (!targetLang) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: target_language' }], isError: true }
  }

  // Validate language
  const validLang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLang)
  if (!validLang) {
    return {
      content: [{ type: 'text' as const, text: `Unsupported language '${targetLang}'. Use list_supported_languages to see available options.` }],
      isError: true,
    }
  }

  // Validate file extension
  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS[ext]) {
    return {
      content: [{ type: 'text' as const, text: `Unsupported file format '${ext}'. Accepted: PDF, DOCX, MD.` }],
      isError: true,
    }
  }

  // Check file exists
  try {
    await fs.access(filePath, fs.constants.R_OK)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return { content: [{ type: 'text' as const, text: `File not found: '${filePath}'.` }], isError: true }
    }
    if (e.code === 'EACCES') {
      return { content: [{ type: 'text' as const, text: `Cannot read file: permission denied.` }], isError: true }
    }
    return { content: [{ type: 'text' as const, text: `Cannot access file: ${e.message}` }], isError: true }
  }

  const doc = await documentsService.uploadFromPath(filePath, targetLang, sourceLang)
  const jobId = await translationService.startTranslation(doc.id)

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        documentId: doc.id,
        jobId,
        status: 'started',
        fileName: doc.originalName,
        targetLanguage: targetLang,
        message: `Translation started. Use get_translation_status with document_id "${doc.id}" to check progress.`,
      }, null, 2),
    }],
  }
}

async function handleGetStatus(args: any, documentsService: DocumentsService) {
  const documentId = args?.document_id as string
  if (!documentId) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: document_id' }], isError: true }
  }

  try {
    const status = await documentsService.getStatus(documentId)
    let stage = 'unknown'
    if (status.status === 'analyzing') stage = 'glossary'
    else if (status.status === 'translating') stage = 'translating'
    else if (status.status === 'assembling') stage = 'assembling'
    else if (status.status === 'completed') stage = 'completed'
    else if (status.status === 'failed') stage = 'failed'
    else if (status.status === 'uploaded') stage = 'queued'

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          documentId: status.id,
          status: status.status,
          stage,
          progress: status.progress,
          completedChunks: status.completedChunks,
          totalChunks: status.totalChunks,
          costSoFar: status.totalCostUsd,
          qualityScore: status.qualityScore,
          error: status.errorCode ? { code: status.errorCode, message: status.errorMessage } : null,
          startedAt: status.startedAt,
          completedAt: status.completedAt,
        }, null, 2),
      }],
    }
  } catch (err) {
    if ((err as any)?.code === 'DOCUMENT_NOT_FOUND') {
      return { content: [{ type: 'text' as const, text: `No translation found with ID '${documentId}'.` }], isError: true }
    }
    throw err
  }
}

async function handleDownloadTranslation(args: any, documentsService: DocumentsService) {
  const documentId = args?.document_id as string
  const outputDir = args?.output_directory as string | undefined

  if (!documentId) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: document_id' }], isError: true }
  }

  let doc: any
  try {
    doc = await documentsService.getById(documentId)
  } catch (err) {
    if ((err as any)?.code === 'DOCUMENT_NOT_FOUND') {
      return { content: [{ type: 'text' as const, text: `No translation found with ID '${documentId}'.` }], isError: true }
    }
    throw err
  }

  if (doc.status !== 'completed') {
    const status = await documentsService.getStatus(documentId)
    return {
      content: [{
        type: 'text' as const,
        text: `Translation is ${status.progress}% complete. Check back shortly.`,
      }],
      isError: true,
    }
  }

  if (!doc.outputPath) {
    // Output generation not yet implemented (Phase 7) — return chunks as text
    const chunks = await documentsService.getChunks(documentId)
    const translatedText = chunks
      .filter((c: any) => c.status === 'completed' && c.translatedText)
      .sort((a: any, b: any) => a.chunkIndex - b.chunkIndex)
      .map((c: any) => c.translatedText)
      .join('\n\n')

    if (outputDir) {
      const outputPath = path.join(outputDir, `translated-${doc.originalName}`)
      await fs.mkdir(outputDir, { recursive: true })
      await fs.writeFile(outputPath, translatedText, 'utf-8')

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            documentId,
            outputPath,
            message: `Translated file saved to ${outputPath}`,
          }, null, 2),
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          documentId,
          translatedText: translatedText.slice(0, 5000) + (translatedText.length > 5000 ? '\n\n... [truncated]' : ''),
          message: 'Translation complete. Provide output_directory to save as a file.',
        }, null, 2),
      }],
    }
  }

  // Has outputPath — copy to requested directory or return path
  if (outputDir) {
    const outputPath = path.join(outputDir, path.basename(doc.outputPath))
    await fs.mkdir(outputDir, { recursive: true })
    await fs.copyFile(doc.outputPath, outputPath)

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ documentId, outputPath, message: `Translated file saved to ${outputPath}` }, null, 2),
      }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        documentId,
        outputPath: doc.outputPath,
        message: `Translated file available at ${doc.outputPath}`,
      }, null, 2),
    }],
  }
}

function handleListLanguages() {
  const languages = SUPPORTED_LANGUAGES.map((l) => ({
    code: l.code,
    name: l.name,
  }))

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        supportedFormats: ['PDF', 'DOCX', 'Markdown'],
        languages,
      }, null, 2),
    }],
  }
}

async function handleGetCost(args: any, documentsService: DocumentsService) {
  const documentId = args?.document_id as string
  if (!documentId) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: document_id' }], isError: true }
  }

  let doc: any
  try {
    doc = await documentsService.getById(documentId)
  } catch (err) {
    if ((err as any)?.code === 'DOCUMENT_NOT_FOUND') {
      return { content: [{ type: 'text' as const, text: `No translation found with ID '${documentId}'.` }], isError: true }
    }
    throw err
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        documentId,
        fileName: doc.originalName,
        status: doc.status,
        totalCostUsd: doc.totalCostUsd,
        totalInputTokens: doc.totalInputTokens,
        totalOutputTokens: doc.totalOutputTokens,
        model: 'gpt-4o-mini',
        breakdown: {
          inputCost: `$${((doc.totalInputTokens || 0) / 1_000_000 * 0.15).toFixed(6)}`,
          outputCost: `$${((doc.totalOutputTokens || 0) / 1_000_000 * 0.60).toFixed(6)}`,
        },
        totalChunks: doc.totalChunks,
        completedChunks: doc.completedChunks,
        translateDurationMs: doc.translateDurationMs,
      }, null, 2),
    }],
  }
}

main().catch((err) => {
  log.error({ err: err.message }, 'MCP server failed to start')
  process.exit(1)
})
