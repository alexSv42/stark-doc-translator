import pino from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from './config'

interface RequestContext {
  correlationId: string
  documentId?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

// MCP mode: log to stderr so stdout is reserved for JSON-RPC.
const isMcp = process.env.MCP_MODE === '1'

export const logger = pino({
  level: isMcp ? 'warn' : config.logLevel,
  transport: !isMcp && config.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  mixin() {
    const ctx = requestContext.getStore()
    return ctx ? { correlationId: ctx.correlationId, ...(ctx.documentId && { documentId: ctx.documentId }) } : {}
  },
}, isMcp ? pino.destination(2) : undefined)

export function createChildLogger(component: string) {
  return logger.child({ component })
}
