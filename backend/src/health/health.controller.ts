import { Controller, Get, Res } from '@nestjs/common'
import { Response } from 'express'
import { DatabaseService } from '../database/database.service'
import { RedisService } from '../redis/redis.service'

@Controller()
export class HealthController {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

  @Get('health')
  async check(@Res() res: Response) {
    const startTime = process.uptime()
    const [dbOk, redisOk] = await Promise.all([this.db.ping(), this.redis.ping()])
    const status = dbOk && redisOk ? 'ok' : 'degraded'
    const statusCode = dbOk && redisOk ? 200 : 503

    res.status(statusCode).json({
      status,
      db: dbOk ? 'connected' : 'disconnected',
      redis: redisOk ? 'connected' : 'disconnected',
      uptime: Math.floor(startTime),
    })
  }
}
