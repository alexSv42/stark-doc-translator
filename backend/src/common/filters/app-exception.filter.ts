import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common'
import { Response } from 'express'
import { AppError } from '../../lib/errors'
import { createChildLogger } from '../../lib/logger'

const log = createChildLogger('error-handler')

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()

    if (exception instanceof AppError) {
      log.warn({ code: exception.code, statusCode: exception.getStatus(), details: exception.details }, exception.userMessage)
      res.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.userMessage,
          details: exception.details,
        },
      })
      return
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const body = exception.getResponse()
      res.status(status).json(typeof body === 'string' ? { error: { code: 'HTTP_ERROR', message: body } } : body)
      return
    }

    // Multer errors
    if (exception instanceof Error && exception.constructor.name === 'MulterError') {
      const multerErr = exception as Error & { code: string }
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds the 100 MB limit.' } })
        return
      }
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Upload error: ${multerErr.message}` } })
      return
    }

    const err = exception instanceof Error ? exception : new Error(String(exception))
    log.error({ err: err.message, stack: err.stack }, 'unhandled error')
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } })
  }
}
