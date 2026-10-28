export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://stark:stark_dev_password@localhost:5432/stark_translator',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  fileStoragePath: process.env.FILE_STORAGE_PATH || './data/files',
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10),
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
  sentryDsn: process.env.SENTRY_DSN || '',
} as const
