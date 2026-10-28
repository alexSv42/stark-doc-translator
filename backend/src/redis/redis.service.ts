import { Injectable } from '@nestjs/common'
import IORedis from 'ioredis'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('redis')

@Injectable()
export class RedisService {
  private instance: IORedis | null = null

  getClient(): IORedis {
    if (!this.instance) {
      this.instance = new IORedis(config.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        retryStrategy(times) {
          const delay = Math.min(times * 200, 5000)
          log.warn({ attempt: times, delayMs: delay }, 'redis reconnecting')
          return delay
        },
      })
      this.instance.on('connect', () => log.info('redis connected'))
      this.instance.on('error', (err) => log.error({ err: err.message }, 'redis error'))
    }
    return this.instance
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.getClient().ping()
      return result === 'PONG'
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if (this.instance) {
      await this.instance.quit()
      this.instance = null
    }
  }
}
