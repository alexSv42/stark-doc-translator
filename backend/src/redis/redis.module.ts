import { Module, Global, OnModuleDestroy } from '@nestjs/common'
import { RedisService } from './redis.service'

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule implements OnModuleDestroy {
  constructor(private redis: RedisService) {}

  async onModuleDestroy() {
    await this.redis.close()
  }
}
