import { Module } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import { DatabaseModule } from './database/database.module'
import { RedisModule } from './redis/redis.module'
import { HealthModule } from './health/health.module'
import { DocumentsModule } from './documents/documents.module'
import { TranslationModule } from './translation/translation.module'
import { StatsModule } from './stats/stats.module'
import { AppExceptionFilter } from './common/filters/app-exception.filter'
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor'
import { QueueService } from './jobs/queue.service'
import { TranslationJobProcessor } from './jobs/translation-job.processor'
import { TranslationAgentService } from './agents/translation-agent'
import { SemanticChunkAgentService } from './agents/semantic-chunk-agent'
import { TranslationService } from './core/translation-service'

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    HealthModule,
    DocumentsModule,
    TranslationModule,
    StatsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    QueueService,
    TranslationAgentService,
    SemanticChunkAgentService,
    TranslationJobProcessor,
    TranslationService,
  ],
  exports: [QueueService, TranslationJobProcessor, TranslationService],
})
export class AppModule {}
