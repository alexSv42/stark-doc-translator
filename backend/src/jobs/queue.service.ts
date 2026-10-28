import { Injectable } from '@nestjs/common'
import { Queue } from 'bullmq'
import { RedisService } from '../redis/redis.service'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('queue')

export interface TranslationJobData {
  documentId: string
}

@Injectable()
export class QueueService {
  private queue: Queue<TranslationJobData> | null = null

  constructor(private redis: RedisService) {}

  getQueue(): Queue<TranslationJobData> {
    if (!this.queue) {
      this.queue = new Queue<TranslationJobData>('translation', {
        connection: this.redis.getClient(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 604800 },
        },
      })
    }
    return this.queue
  }

  async addTranslationJob(documentId: string): Promise<string> {
    const queue = this.getQueue()
    const job = await queue.add('translate', { documentId }, {
      jobId: `translate-${documentId}-${Date.now()}`,
    })
    log.info({ documentId, jobId: job.id }, 'translation job queued')
    return job.id!
  }

  async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close()
      this.queue = null
    }
  }
}
