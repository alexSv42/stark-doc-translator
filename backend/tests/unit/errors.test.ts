import { describe, it, expect } from 'vitest'
import { AppError, Errors } from '../../src/lib/errors'

describe('AppError', () => {
  it('extends HttpException with code, userMessage, and details', () => {
    const err = new AppError('TEST_CODE', 418, 'Something went wrong', { foo: 'bar' })
    expect(err.code).toBe('TEST_CODE')
    expect(err.userMessage).toBe('Something went wrong')
    expect(err.message).toBe('Something went wrong')
    expect(err.getStatus()).toBe(418)
    expect(err.details).toEqual({ foo: 'bar' })
  })

  it('response body has structured error shape', () => {
    const err = new AppError('ERR', 400, 'Bad request')
    const body = err.getResponse() as any
    expect(body.error.code).toBe('ERR')
    expect(body.error.message).toBe('Bad request')
  })
})

describe('Errors factory', () => {
  it('noFileProvided → 400', () => {
    const err = Errors.noFileProvided()
    expect(err.getStatus()).toBe(400)
    expect(err.code).toBe('NO_FILE_PROVIDED')
    expect(err.message).toContain('No file')
  })

  it('fileTooLarge → 413 with details', () => {
    const err = Errors.fileTooLarge(150)
    expect(err.getStatus()).toBe(413)
    expect(err.code).toBe('FILE_TOO_LARGE')
    expect(err.details).toEqual({ sizeMb: 150 })
  })

  it('unsupportedFormat → 415 with ext', () => {
    const err = Errors.unsupportedFormat('txt')
    expect(err.getStatus()).toBe(415)
    expect(err.code).toBe('UNSUPPORTED_FORMAT')
    expect(err.message).toContain('txt')
    expect(err.message).toContain('PDF, DOCX, MD')
  })

  it('storageFull → 507', () => {
    const err = Errors.storageFull()
    expect(err.getStatus()).toBe(507)
    expect(err.code).toBe('STORAGE_FULL')
  })

  it('dbConnectionFailed → 503', () => {
    const err = Errors.dbConnectionFailed()
    expect(err.getStatus()).toBe(503)
    expect(err.message).toContain('temporarily unavailable')
  })

  it('redisConnectionFailed → 503', () => {
    const err = Errors.redisConnectionFailed()
    expect(err.getStatus()).toBe(503)
  })

  it('documentNotFound → 404 with id', () => {
    const err = Errors.documentNotFound('abc-123')
    expect(err.getStatus()).toBe(404)
    expect(err.code).toBe('DOCUMENT_NOT_FOUND')
  })

  it('invalidLanguage → 400 with code', () => {
    const err = Errors.invalidLanguage('xx')
    expect(err.getStatus()).toBe(400)
    expect(err.code).toBe('INVALID_LANGUAGE')
    expect(err.message).toContain('xx')
  })

  it('corruptFile → 422', () => {
    const err = Errors.corruptFile()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('CORRUPT_FILE')
  })

  it('passwordProtected → 422', () => {
    const err = Errors.passwordProtected()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('PASSWORD_PROTECTED')
    expect(err.message).toContain('password')
  })

  it('scannedPdf → 422', () => {
    const err = Errors.scannedPdf()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('SCANNED_PDF_DETECTED')
  })

  it('noExtractableText → 422', () => {
    const err = Errors.noExtractableText()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('NO_EXTRACTABLE_TEXT')
  })

  it('documentTooLong → 422 with page count', () => {
    const err = Errors.documentTooLong(1000)
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('DOCUMENT_TOO_LONG')
    expect(err.message).toContain('1000')
  })

  it('parseTimeout → 422', () => {
    const err = Errors.parseTimeout()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('PARSE_TIMEOUT')
  })

  it('securityViolation → 422', () => {
    const err = Errors.securityViolation()
    expect(err.getStatus()).toBe(422)
    expect(err.code).toBe('SECURITY_VIOLATION')
  })
})
