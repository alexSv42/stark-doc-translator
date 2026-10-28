import { Injectable } from '@nestjs/common'
import { QueueService } from '../jobs/queue.service'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('translation-service')

@Injectable()
export class TranslationService {
  constructor(private queue: QueueService) {}

  async startTranslation(documentId: string): Promise<string> {
    log.info({ documentId }, 'starting translation')
    const jobId = await this.queue.addTranslationJob(documentId)
    return jobId
  }
}
