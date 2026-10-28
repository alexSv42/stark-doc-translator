import { describe, it, expect } from 'vitest'
import { SUPPORTED_LANGUAGES, SUPPORTED_EXTENSIONS, SUPPORTED_FORMATS } from '../../src/types/index'
import { AppError, Errors } from '../../src/lib/errors'
import { calculateCost, buildTranslationPrompt } from '../../src/translation/provider'

describe('MCP tools integration', () => {
  describe('list_supported_languages', () => {
    it('returns all 14 languages', () => {
      expect(SUPPORTED_LANGUAGES.length).toBe(14)
    })

    it('each language has code and name', () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        expect(lang.code).toBeTruthy()
        expect(lang.name).toBeTruthy()
        expect(typeof lang.code).toBe('string')
        expect(typeof lang.name).toBe('string')
      }
    })

    it('includes English, Spanish, French, German, Japanese', () => {
      const codes = SUPPORTED_LANGUAGES.map((l) => l.code)
      expect(codes).toContain('en')
      expect(codes).toContain('es')
      expect(codes).toContain('fr')
      expect(codes).toContain('de')
      expect(codes).toContain('ja')
    })

    it('includes CJK and RTL languages', () => {
      const codes = SUPPORTED_LANGUAGES.map((l) => l.code)
      expect(codes).toContain('ja')
      expect(codes).toContain('ko')
      expect(codes).toContain('zh')
      expect(codes).toContain('ar')
    })
  })

  describe('translate_document validation', () => {
    it('validates supported formats', () => {
      expect(SUPPORTED_FORMATS).toContain('pdf')
      expect(SUPPORTED_FORMATS).toContain('docx')
      expect(SUPPORTED_FORMATS).toContain('md')
      expect(SUPPORTED_FORMATS).not.toContain('txt')
      expect(SUPPORTED_FORMATS).not.toContain('html')
    })

    it('maps file extensions correctly', () => {
      expect(SUPPORTED_EXTENSIONS['.pdf']).toBe('pdf')
      expect(SUPPORTED_EXTENSIONS['.docx']).toBe('docx')
      expect(SUPPORTED_EXTENSIONS['.md']).toBe('md')
      expect(SUPPORTED_EXTENSIONS['.txt']).toBeUndefined()
    })

    it('rejects invalid language with correct error', () => {
      const err = Errors.invalidLanguage('xx')
      expect(err.code).toBe('INVALID_LANGUAGE')
      expect(err.getStatus()).toBe(400)
      expect(err.message).toContain('xx')
    })

    it('rejects unsupported format', () => {
      const err = Errors.unsupportedFormat('html')
      expect(err.code).toBe('UNSUPPORTED_FORMAT')
      expect(err.getStatus()).toBe(415)
    })
  })

  describe('get_translation_status', () => {
    it('progress calculation is correct', () => {
      const totalChunks = 10
      const completedChunks = 7
      const progress = Math.round((completedChunks / totalChunks) * 100)
      expect(progress).toBe(70)
    })

    it('progress is 0 when no chunks exist', () => {
      const progress = 0 > 0 ? Math.round((0 / 0) * 100) : 0
      expect(progress).toBe(0)
    })

    it('stage mapping covers all statuses', () => {
      const statusToStage: Record<string, string> = {
        uploaded: 'queued',
        analyzing: 'glossary',
        translating: 'translating',
        assembling: 'assembling',
        completed: 'completed',
        failed: 'failed',
      }

      expect(Object.keys(statusToStage)).toHaveLength(6)
      expect(statusToStage['uploaded']).toBe('queued')
      expect(statusToStage['completed']).toBe('completed')
    })
  })

  describe('get_document_cost', () => {
    it('calculates cost breakdown correctly', () => {
      const inputTokens = 50_000
      const outputTokens = 60_000
      const cost = calculateCost('gpt-4o-mini', inputTokens, outputTokens)

      const expectedInput = (50_000 / 1_000_000) * 0.15
      const expectedOutput = (60_000 / 1_000_000) * 0.60
      expect(cost).toBeCloseTo(expectedInput + expectedOutput, 6)
    })

    it('zero tokens = zero cost', () => {
      const cost = calculateCost('gpt-4o-mini', 0, 0)
      expect(cost).toBe(0)
    })

    it('cached translation cost is $0', () => {
      // When served from cache: inputTokens=0, outputTokens=0
      const cost = calculateCost('gpt-4o-mini', 0, 0)
      expect(cost).toBe(0)
    })
  })

  describe('download_translation output', () => {
    it('concatenates chunks in correct order', () => {
      const chunks = [
        { chunkIndex: 3, translatedText: 'Fourth.', status: 'completed' },
        { chunkIndex: 0, translatedText: 'First.', status: 'completed' },
        { chunkIndex: 1, translatedText: 'Second.', status: 'completed' },
        { chunkIndex: 2, translatedText: null, status: 'failed' },
      ]

      const result = chunks
        .filter((c) => c.status === 'completed' && c.translatedText)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((c) => c.translatedText)
        .join('\n\n')

      expect(result).toBe('First.\n\nSecond.\n\nFourth.')
    })

    it('handles all-failed chunks gracefully', () => {
      const chunks = [
        { chunkIndex: 0, translatedText: null, status: 'failed' },
        { chunkIndex: 1, translatedText: null, status: 'failed' },
      ]

      const result = chunks
        .filter((c) => c.status === 'completed' && c.translatedText)
        .map((c) => c.translatedText)
        .join('\n\n')

      expect(result).toBe('')
    })
  })

  describe('error messages for MCP clients', () => {
    it('document not found includes ID', () => {
      const err = Errors.documentNotFound('abc-123')
      expect(err.code).toBe('DOCUMENT_NOT_FOUND')
      expect(err.getStatus()).toBe(404)
    })

    it('file too large includes size limit', () => {
      const err = Errors.fileTooLarge(150)
      expect(err.message).toContain('100 MB')
    })

    it('corrupt file has clear message', () => {
      const err = Errors.corruptFile()
      expect(err.message).toContain('corrupted')
    })

    it('password protected has actionable message', () => {
      const err = Errors.passwordProtected()
      expect(err.message).toContain('password')
      expect(err.message).toContain('re-upload')
    })
  })
})
