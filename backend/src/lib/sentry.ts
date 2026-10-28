import * as Sentry from '@sentry/node'
import { config } from './config'
import { createChildLogger } from './logger'

const log = createChildLogger('sentry')

let initialized = false

/**
 * Initialize Sentry error tracking and performance monitoring.
 * Call once at process startup (before any other imports that could throw).
 *
 * No-ops when SENTRY_DSN is not set — zero overhead in local/test environments.
 */
export function initSentry(serviceName: 'api' | 'worker' | 'mcp'): void {
  if (!config.sentryDsn) {
    log.debug('SENTRY_DSN not set — skipping Sentry init')
    return
  }

  if (initialized) return
  initialized = true

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    serverName: serviceName,
    tracesSampleRate: config.nodeEnv === 'production' ? 0.2 : 1.0,
    profileSessionSampleRate: config.nodeEnv === 'production' ? 0.1 : 0,
    integrations: [
      Sentry.httpIntegration(),
    ],
    beforeSend(event) {
      // Scrub OpenAI API key from any breadcrumbs or extras
      if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
          if (bc.data && typeof bc.data === 'object') {
            for (const key of Object.keys(bc.data)) {
              if (/api[_-]?key|authorization|token/i.test(key)) {
                bc.data[key] = '[REDACTED]'
              }
            }
          }
        }
      }
      return event
    },
  })

  log.info({ serviceName, environment: config.nodeEnv }, 'Sentry initialized')
}

/**
 * Capture an exception with optional context for translation pipeline errors.
 */
export function captureTranslationError(
  err: Error,
  context: {
    documentId?: string
    chunkIndex?: number
    phase?: 'parse' | 'glossary' | 'translate' | 'assemble'
    [key: string]: unknown
  },
): void {
  if (!initialized) return

  Sentry.withScope((scope) => {
    if (context.documentId) scope.setTag('documentId', context.documentId)
    if (context.phase) scope.setTag('phase', context.phase)
    if (context.chunkIndex != null) scope.setExtra('chunkIndex', context.chunkIndex)
    scope.setExtras(context)
    Sentry.captureException(err)
  })
}

export { Sentry }
