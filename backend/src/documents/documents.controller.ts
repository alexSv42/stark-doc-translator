import {
  Controller, Get, Post, Delete, Param, Body,
  UploadedFile, UseInterceptors, HttpCode, Res, Sse,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Response } from 'express'
import multer from 'multer'
import { Observable, interval, map, takeWhile, startWith, switchMap, from, of, catchError } from 'rxjs'
import { DocumentsService } from './documents.service'
import { TranslationService } from '../core/translation-service'
import { Errors } from '../lib/errors'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('documents-controller')

interface MessageEvent {
  data: string
}

@Controller('api/documents')
export class DocumentsController {
  constructor(
    private documentsService: DocumentsService,
    private translationService: TranslationService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeMb * 1024 * 1024 },
  }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('targetLanguage') targetLanguage?: string,
    @Body('sourceLanguage') sourceLanguage?: string,
  ) {
    if (!file) throw Errors.noFileProvided()

    const doc = await this.documentsService.upload(file, targetLanguage, sourceLanguage)
    return {
      id: doc.id,
      name: doc.originalName,
      format: doc.format,
      size: doc.fileSizeBytes,
      status: doc.status,
      createdAt: doc.createdAt,
    }
  }

  @Post(':id/translate')
  async translate(
    @Param('id') id: string,
    @Body('targetLanguage') targetLanguage?: string,
    @Body('sourceLanguage') sourceLanguage?: string,
  ) {
    const doc = await this.documentsService.getById(id)
    const jobId = await this.translationService.startTranslation(doc.id)
    return { documentId: doc.id, jobId, status: 'started' }
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const doc = await this.documentsService.cancel(id)
    return { id, status: doc.status, errorCode: (doc as any).errorCode }
  }

  @Get()
  async list() {
    return this.documentsService.list()
  }

  @Get(':id/status')
  async status(@Param('id') id: string) {
    return this.documentsService.getStatus(id)
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.documentsService.getById(id)

    if (doc.status !== 'completed') {
      const status = await this.documentsService.getStatus(id)
      res.status(400).json({
        error: { code: 'NOT_COMPLETE', message: `Translation is ${status.progress}% complete.` },
      })
      return
    }

    // If output file exists, stream it
    if (doc.outputPath) {
      const fs = await import('node:fs')
      const filename = `translated-${doc.originalName}`

      const mimeMap: Record<string, string> = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        md: 'text/markdown; charset=utf-8',
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Type', mimeMap[doc.format] || 'application/octet-stream')

      const stream = fs.createReadStream(doc.outputPath)
      stream.pipe(res)
      return
    }

    // No output file yet (output generation Phase 7) — return concatenated chunks as text
    const chunks = await this.documentsService.getChunks(id)
    const translatedText = chunks
      .filter((c) => c.status === 'completed' && c.translatedText)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => c.translatedText)
      .join('\n\n')

    const filename = `translated-${doc.originalName.replace(/\.[^.]+$/, '.txt')}`
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(translatedText)
  }

  @Get(':id/events')
  async events(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Send current state immediately on connect
    try {
      const status = await this.documentsService.getStatus(id)
      sendEvent({
        type: status.status === 'completed' ? 'completed' : status.status === 'failed' ? 'failed' : 'progress',
        ...status,
        stage: this.mapStage(status.status),
        costSoFar: status.totalCostUsd,
      })
    } catch {
      sendEvent({ type: 'failed', errorCode: 'DOCUMENT_NOT_FOUND', errorMessage: 'Document not found.' })
      res.end()
      return
    }

    // Poll for updates every 2 seconds until terminal state
    const pollInterval = setInterval(async () => {
      try {
        const status = await this.documentsService.getStatus(id)
        const isTerminal = status.status === 'completed' || status.status === 'failed'

        sendEvent({
          type: isTerminal ? status.status : 'progress',
          ...status,
          stage: this.mapStage(status.status),
          costSoFar: status.totalCostUsd,
        })

        if (isTerminal) {
          clearInterval(pollInterval)
          res.end()
        }
      } catch {
        clearInterval(pollInterval)
        res.end()
      }
    }, 2000)

    // Clean up on client disconnect
    res.on('close', () => {
      clearInterval(pollInterval)
    })
  }

  private mapStage(status: string): string {
    switch (status) {
      case 'uploaded': return 'queued'
      case 'analyzing': return 'glossary'
      case 'translating': return 'translating'
      case 'assembling': return 'assembling'
      case 'completed': return 'completed'
      case 'failed': return 'failed'
      default: return 'unknown'
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.documentsService.remove(id)
  }
}
