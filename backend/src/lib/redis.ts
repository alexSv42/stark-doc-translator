import IORedis from 'ioredis'
import { config } from './config'
import { createChildLogger } from './logger'

const log = createChildLogger('redis')

let redisInstance: IORedis | null = null

export function getRedis(): IORedis {
  if (!redisInstance) {
    redisInstance = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000)
        log.warn({ attempt: times, delayMs: delay }, 'redis reconnecting')
        return delay
      },
    })
    redisInstance.on('connect', () => log.info('redis connected'))
    redisInstance.on('error', (err) => log.error({ err: err.message }, 'redis error'))
  }
  return redisInstance
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit()
    redisInstance = null
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getRedis().ping()
    return result === 'PONG'
  } catch {
    return false
  }
}
