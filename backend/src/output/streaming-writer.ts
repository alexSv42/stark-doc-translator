import fs from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('streaming-writer')

const DEFAULT_FLUSH_THRESHOLD = 3

/**
 * Buffers translated chunks and flushes them to the output file periodically.
 * For markdown: appends text directly.
 * For PDF/DOCX: accumulates chunks and generates the final file on close
 * (these formats need the full content to produce a valid file).
 */
export class StreamingOutputWriter {
  private buffer: Array<{ chunkIndex: number; translatedText: string; metadata: any }> = []
  private flushedChunks: Array<{ chunkIndex: number; translatedText: string; metadata: any }> = []
  private outputPath: string
  private format: string
  private flushThreshold: number
  private metadata: { title: string; sourceLanguage: string; targetLanguage: string }
  private mdStream: WriteStream | null = null
  private chunksFlushed = 0

  constructor(
    outputPath: string,
    format: string,
    metadata: { title: string; sourceLanguage: string; targetLanguage: string },
    flushThreshold = DEFAULT_FLUSH_THRESHOLD,
  ) {
    this.outputPath = outputPath
    this.format = format
    this.metadata = metadata
    this.flushThreshold = flushThreshold
  }

  async init(): Promise<void> {
    const dir = this.outputPath.substring(0, this.outputPath.lastIndexOf('/'))
    await fs.mkdir(dir, { recursive: true })

    if (this.format === 'md') {
      this.mdStream = createWriteStream(this.outputPath, { flags: 'w', encoding: 'utf-8' })
    }
  }

  /**
   * Add a translated chunk to the buffer. Flushes to disk when threshold is reached.
   */
  async addChunk(chunkIndex: number, translatedText: string, metadata: any): Promise<void> {
    const entry = { chunkIndex, translatedText, metadata }
    this.buffer.push(entry)
    this.flushedChunks.push(entry)

    if (this.buffer.length >= this.flushThreshold) {
      await this.flush()
    }
  }

  /**
   * Flush buffered chunks to disk.
   * - Markdown: append text immediately (true streaming)
   * - PDF/DOCX: accumulate (needs full content for valid file structure)
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    if (this.format === 'md' && this.mdStream) {
      for (const chunk of this.buffer) {
        const separator = this.chunksFlushed > 0 ? '\n\n' : ''
        this.mdStream.write(separator + chunk.translatedText)
        this.chunksFlushed++
      }
    }

    log.debug({
      format: this.format,
      flushed: this.buffer.length,
      totalFlushed: this.flushedChunks.length,
    }, 'buffer flushed')

    this.buffer = []
  }

  /**
   * Finalize the output file. Must be called after all chunks are added.
   * - Markdown: closes the write stream
   * - PDF/DOCX: generates the full file from accumulated chunks
   */
  async close(): Promise<void> {
    // Flush any remaining buffered chunks
    await this.flush()

    if (this.format === 'md') {
      if (this.mdStream) {
        await new Promise<void>((resolve, reject) => {
          this.mdStream!.end(() => resolve())
          this.mdStream!.on('error', reject)
        })
        this.mdStream = null
      }
    } else {
      // PDF and DOCX need to generate the complete file from all accumulated chunks
      const { getOutputGenerator } = await import('./index')
      const generator = await getOutputGenerator(this.format)
      const sorted = [...this.flushedChunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
      await generator.generate(
        sorted.map((c) => ({
          chunkIndex: c.chunkIndex,
          sourceText: '',
          translatedText: c.translatedText,
          metadata: c.metadata,
        })),
        this.outputPath,
        this.metadata,
      )
    }

    log.info({
      outputPath: this.outputPath,
      format: this.format,
      totalChunks: this.flushedChunks.length,
    }, 'streaming output finalized')
  }

  get chunksWritten(): number {
    return this.flushedChunks.length
  }
}
