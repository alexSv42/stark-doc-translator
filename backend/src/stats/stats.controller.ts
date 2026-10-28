import { Controller, Get } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'

@Controller('api/stats')
export class StatsController {
  constructor(private db: DatabaseService) {}

  @Get()
  async getStats() {
    const drizzleDb = this.db.getDb()

    const docResult = await drizzleDb.execute(sql`
      SELECT
        COUNT(*)::int                                         AS "totalDocuments",
        COUNT(*) FILTER (WHERE status = 'completed')::int     AS "completedDocuments",
        COUNT(*) FILTER (WHERE status = 'failed')::int        AS "failedDocuments",
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'uploaded'))::int AS "activeDocuments",
        COALESCE(SUM(total_cost_usd), 0)::float               AS "totalCostUsd",
        COALESCE(SUM(total_input_tokens), 0)::bigint           AS "totalInputTokens",
        COALESCE(SUM(total_output_tokens), 0)::bigint          AS "totalOutputTokens",
        COALESCE(AVG(total_cost_usd) FILTER (WHERE status = 'completed'), 0)::float AS "avgCostPerDocument",
        COALESCE(AVG(total_duration_ms) FILTER (WHERE status = 'completed'), 0)::float AS "avgDurationMs",
        COALESCE(AVG(parse_duration_ms) FILTER (WHERE status = 'completed'), 0)::float AS "avgParseDurationMs",
        COALESCE(AVG(translate_duration_ms) FILTER (WHERE status = 'completed'), 0)::float AS "avgTranslateDurationMs",
        COALESCE(AVG(assemble_duration_ms) FILTER (WHERE status = 'completed'), 0)::float AS "avgAssembleDurationMs"
      FROM documents
    `) as any
    const row = docResult?.rows?.[0] ?? docResult?.[0]

    const cacheResult = await drizzleDb.execute(sql`
      SELECT COUNT(*)::int AS "totalCacheEntries"
      FROM translation_cache
    `) as any
    const cacheRow = cacheResult?.rows?.[0] ?? cacheResult?.[0]

    const chunkResult = await drizzleDb.execute(sql`
      SELECT
        COUNT(*)::int                                    AS "totalChunks",
        COUNT(*) FILTER (WHERE cost_usd = '0')::int      AS "cachedChunks"
      FROM translation_chunks
      WHERE status = 'completed'
    `) as any
    const chunkRow = chunkResult?.rows?.[0] ?? chunkResult?.[0]

    const totalChunks = chunkRow?.totalChunks || 0
    const cachedChunks = chunkRow?.cachedChunks || 0
    const cacheHitRate = totalChunks > 0 ? cachedChunks / totalChunks : 0

    return {
      totalDocuments: row?.totalDocuments || 0,
      completedDocuments: row?.completedDocuments || 0,
      failedDocuments: row?.failedDocuments || 0,
      activeDocuments: row?.activeDocuments || 0,
      totalCostUsd: parseFloat((row?.totalCostUsd || 0).toFixed(6)),
      avgCostPerDocument: parseFloat((row?.avgCostPerDocument || 0).toFixed(6)),
      totalInputTokens: Number(row?.totalInputTokens || 0),
      totalOutputTokens: Number(row?.totalOutputTokens || 0),
      cacheHitRate: parseFloat(cacheHitRate.toFixed(4)),
      cacheEntries: cacheRow?.totalCacheEntries || 0,
      avgDurationMs: Math.round(row?.avgDurationMs || 0),
      avgParseDurationMs: Math.round(row?.avgParseDurationMs || 0),
      avgTranslateDurationMs: Math.round(row?.avgTranslateDurationMs || 0),
      avgAssembleDurationMs: Math.round(row?.avgAssembleDurationMs || 0),
    }
  }
}
