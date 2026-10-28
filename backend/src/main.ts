import 'reflect-metadata'
import { initSentry } from './lib/sentry'
initSentry('api')

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { config } from './lib/config'
import { createChildLogger } from './lib/logger'
import { runMigrations } from './db/migrate'

const log = createChildLogger('api')

async function bootstrap() {
  await runMigrations()

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: true,
      exposedHeaders: ['Content-Disposition'],
    },
    logger: ['error', 'warn'],
  })

  app.enableShutdownHooks()

  await app.listen(config.port)
  log.info({ port: config.port, env: config.nodeEnv }, 'NestJS api server started')
}

bootstrap().catch((err) => {
  log.error({ err: err.message }, 'failed to start api server')
  process.exit(1)
})
