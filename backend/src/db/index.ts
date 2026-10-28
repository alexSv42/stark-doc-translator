import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { config } from '../lib/config'
import { createChildLogger } from '../lib/logger'

const log = createChildLogger('db')

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    pool.on('error', (err) => {
      log.error({ err: err.message }, 'unexpected pool error')
    })
  }
  return pool
}

export function getDb() {
  return drizzle(getPool(), { schema })
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    const client = await getPool().connect()
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
