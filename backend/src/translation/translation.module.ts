import { Module } from '@nestjs/common'
import { TranslationCacheService } from './cache.service'

@Module({
  providers: [TranslationCacheService],
  exports: [TranslationCacheService],
})
export class TranslationModule {}
