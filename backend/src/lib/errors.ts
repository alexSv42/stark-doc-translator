import { HttpException } from '@nestjs/common'

export class AppError extends HttpException {
  public code: string
  public userMessage: string
  public details?: Record<string, unknown>

  constructor(code: string, statusCode: number, userMessage: string, details?: Record<string, unknown>) {
    super({ error: { code, message: userMessage, details } }, statusCode)
    this.message = userMessage
    this.code = code
    this.userMessage = userMessage
    this.details = details
  }
}

export const Errors = {
  noFileProvided: () =>
    new AppError('NO_FILE_PROVIDED', 400, 'No file was provided. Please select a file to upload.'),
  fileTooLarge: (sizeMb: number) =>
    new AppError('FILE_TOO_LARGE', 413, `File exceeds the 100 MB limit.`, { sizeMb }),
  unsupportedFormat: (ext: string) =>
    new AppError('UNSUPPORTED_FORMAT', 415, `'.${ext}' is not supported. Accepted: PDF, DOCX, MD.`, { ext }),
  storageFull: () =>
    new AppError('STORAGE_FULL', 507, 'Server storage is full.'),
  dbConnectionFailed: () =>
    new AppError('DB_CONNECTION_FAILED', 503, 'Service temporarily unavailable.'),
  redisConnectionFailed: () =>
    new AppError('REDIS_CONNECTION_FAILED', 503, 'Service temporarily unavailable.'),
  documentNotFound: (id: string) =>
    new AppError('DOCUMENT_NOT_FOUND', 404, 'Document not found.', { id }),
  invalidLanguage: (code: string) =>
    new AppError('INVALID_LANGUAGE', 400, `Unsupported language '${code}'.`, { code }),
  corruptFile: () =>
    new AppError('CORRUPT_FILE', 422, 'This file is corrupted and cannot be opened.'),
  passwordProtected: () =>
    new AppError('PASSWORD_PROTECTED', 422, 'This PDF is password-protected. Remove the password and re-upload.'),
  scannedPdf: () =>
    new AppError('SCANNED_PDF_DETECTED', 422, 'This PDF contains scanned images instead of extractable text.'),
  noExtractableText: () =>
    new AppError('NO_EXTRACTABLE_TEXT', 422, 'No text could be extracted from this file.'),
  documentTooLong: (pages: number) =>
    new AppError('DOCUMENT_TOO_LONG', 422, `This document has ${pages} pages (limit: 500).`, { pages }),
  parseTimeout: () =>
    new AppError('PARSE_TIMEOUT', 422, 'Parsing took too long. The file may be too complex.'),
  securityViolation: () =>
    new AppError('SECURITY_VIOLATION', 422, 'This file failed security validation.'),
} as const
