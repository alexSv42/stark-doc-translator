import { Module, forwardRef } from '@nestjs/common'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { TranslationService } from '../core/translation-service'
import { QueueService } from '../jobs/queue.service'

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, TranslationService, QueueService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
