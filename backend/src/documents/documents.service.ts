import { Injectable } from '@nestjs/common'
import path from 'node:path'
import fs from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { eq, desc } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { documents, translationChunks } from '../db/schema'
import { Errors } from '../lib/errors'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'
import { SUPPORTED_EXTENSIONS, type SupportedFormat } from '../types/index'

const log = createChildLogger('documents')

@Injectable()
export class DocumentsService {
  constructor(private db: DatabaseService) {}

  getFormat(filename: string): SupportedFormat {
    const ext = path.extname(filename).toLowerCase()
    const format = SUPPORTED_EXTENSIONS[ext]
    if (!format) throw Errors.unsupportedFormat(ext.replace('.', ''))
    return format
  }

  async upload(file: Express.Multer.File, targetLanguage?: string, sourceLanguage?: string) {
    if (!file) throw Errors.noFileProvided()

    const originalName = file.originalname
    const format = this.getFormat(originalName)
    const fileId = uuidv4()
    const ext = path.extname(originalName).toLowerCase()
    const storageName = `${fileId}${ext}`

    await fs.mkdir(config.fileStoragePath, { recursive: true })
    const storagePath = path.join(config.fileStoragePath, storageName)

    try {
      await fs.writeFile(storagePath, file.buffer)
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOSPC') throw Errors.storageFull()
      throw err
    }

    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.insert(documents).values({
      originalName,
      storagePath,
      format,
      fileSizeBytes: file.size,
      targetLanguage: targetLanguage || 'es',
      sourceLanguage: sourceLanguage || null,
      status: 'uploaded',
    }).returning()

    log.info({ documentId: doc.id, originalName, format, fileSizeBytes: file.size }, 'document uploaded')
    return doc
  }

  async list() {
    const drizzleDb = this.db.getDb()
    const docs = await drizzleDb.select().from(documents).orderBy(desc(documents.createdAt)).limit(50)
    return docs.map((d) => ({
      id: d.id,
      name: d.originalName,
      format: d.format,
      size: d.fileSizeBytes,
      status: d.status,
      sourceLanguage: d.sourceLanguage,
      targetLanguage: d.targetLanguage,
      totalChunks: d.totalChunks,
      completedChunks: d.completedChunks,
      totalCostUsd: d.totalCostUsd,
      qualityScore: d.qualityScore,
      errorCode: d.errorCode,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
    }))
  }

  async getStatus(id: string) {
    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.select().from(documents).where(eq(documents.id, id))
    if (!doc) throw Errors.documentNotFound(id)

    const totalChunks = doc.totalChunks || 0
    const completedChunks = doc.completedChunks || 0

    // Phase-aware progress:
    //   uploaded/queued  →  0%
    //   analyzing        →  5%  (parsing + glossary)
    //   translating      →  10-95% proportional to completedChunks/totalChunks
    //   assembling       →  96%
    //   completed        →  100%
    //   failed           →  keep last known progress
    let progress: number
    switch (doc.status) {
      case 'uploaded':
        progress = 0
        break
      case 'analyzing':
        progress = 5
        break
      case 'translating':
        if (totalChunks > 0) {
          const chunkProgress = Math.min(completedChunks / totalChunks, 1)
          progress = Math.round(10 + chunkProgress * 85) // 10% → 95%
        } else {
          progress = 10
        }
        break
      case 'assembling':
        progress = 96
        break
      case 'completed':
        progress = 100
        break
      case 'failed':
        progress = totalChunks > 0 ? Math.round(10 + Math.min(completedChunks / totalChunks, 1) * 85) : 0
        break
      default:
        progress = 0
    }

    return {
      id: doc.id,
      status: doc.status,
      progress,
      completedChunks,
      totalChunks,
      errorCode: doc.errorCode,
      errorMessage: doc.errorMessage,
      totalCostUsd: doc.totalCostUsd,
      qualityScore: doc.qualityScore,
      totalDurationMs: doc.totalDurationMs,
      createdAt: doc.createdAt,
      startedAt: doc.startedAt,
      completedAt: doc.completedAt,
    }
  }

  async remove(id: string) {
    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.select().from(documents).where(eq(documents.id, id))
    if (!doc) throw Errors.documentNotFound(id)

    try { await fs.unlink(doc.storagePath) } catch { /* file may already be gone */ }
    if (doc.outputPath) {
      try { await fs.unlink(doc.outputPath) } catch { /* file may already be gone */ }
    }

    await drizzleDb.delete(documents).where(eq(documents.id, id))
    log.info({ documentId: id }, 'document deleted')
  }

  async uploadFromPath(filePath: string, targetLanguage: string, sourceLanguage?: string) {
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat) throw Errors.documentNotFound(filePath)

    const originalName = path.basename(filePath)
    const format = this.getFormat(originalName)
    const fileId = uuidv4()
    const ext = path.extname(originalName).toLowerCase()
    const storageName = `${fileId}${ext}`

    await fs.mkdir(config.fileStoragePath, { recursive: true })
    const storagePath = path.join(config.fileStoragePath, storageName)
    await fs.copyFile(filePath, storagePath)

    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.insert(documents).values({
      originalName,
      storagePath,
      format,
      fileSizeBytes: stat.size,
      targetLanguage,
      sourceLanguage: sourceLanguage || null,
      status: 'uploaded',
    }).returning()

    log.info({ documentId: doc.id, originalName, format, fileSizeBytes: stat.size }, 'document uploaded from path')
    return doc
  }

  async getById(id: string) {
    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.select().from(documents).where(eq(documents.id, id))
    if (!doc) throw Errors.documentNotFound(id)
    return doc
  }

  async cancel(id: string) {
    const drizzleDb = this.db.getDb()
    const [doc] = await drizzleDb.select().from(documents).where(eq(documents.id, id))
    if (!doc) throw Errors.documentNotFound(id)

    if (doc.status === 'completed' || doc.status === 'failed') {
      return doc
    }

    await drizzleDb
      .update(documents)
      .set({
        status: 'failed',
        errorCode: 'CANCELLED',
        errorMessage: 'Translation cancelled by user.',
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id))

    log.info({ documentId: id }, 'document cancelled')
    return { ...doc, status: 'failed' as const, errorCode: 'CANCELLED', errorMessage: 'Translation cancelled by user.' }
  }

  async getChunks(documentId: string) {
    const drizzleDb = this.db.getDb()
    return drizzleDb.select().from(translationChunks).where(eq(translationChunks.documentId, documentId))
  }
}
