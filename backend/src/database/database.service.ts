import { Injectable } from '@nestjs/common'
import pg from 'pg'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('db')

@Injectable()
export class DatabaseService {
  private pool: pg.Pool | null = null

  getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: config.databaseUrl,
        max: 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      })
      this.pool.on('error', (err) => {
        log.error({ err: err.message }, 'unexpected pool error')
      })
    }
    return this.pool
  }

  getDb(): NodePgDatabase<typeof schema> {
    return drizzle(this.getPool(), { schema })
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.getPool().connect()
      try {
        await client.query('SELECT 1')
        return true
      } finally {
        client.release()
      }
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }
}
