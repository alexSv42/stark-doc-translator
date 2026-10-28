import { Module, Global, OnModuleDestroy } from '@nestjs/common'
import { DatabaseService } from './database.service'

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(private db: DatabaseService) {}

  async onModuleDestroy() {
    await this.db.close()
  }
}
