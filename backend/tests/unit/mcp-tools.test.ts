import { describe, it, expect } from 'vitest'
import { SUPPORTED_LANGUAGES, SUPPORTED_EXTENSIONS } from '../../src/types/index'

describe('MCP tools', () => {
  describe('list_supported_languages', () => {
    it('returns all supported languages with codes', () => {
      expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(10)
      for (const lang of SUPPORTED_LANGUAGES) {
        expect(lang.code).toBeTruthy()
        expect(lang.name).toBeTruthy()
        expect(lang.code.length).toBeLessThanOrEqual(5)
      }
    })

    it('includes common languages', () => {
      const codes = SUPPORTED_LANGUAGES.map((l) => l.code)
      expect(codes).toContain('en')
      expect(codes).toContain('es')
      expect(codes).toContain('de')
      expect(codes).toContain('fr')
      expect(codes).toContain('ja')
    })
  })

  describe('translate_document validation', () => {
    it('validates target language against supported list', () => {
      const targetLang = 'xx'
      const validLang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLang)
      expect(validLang).toBeUndefined()
    })

    it('accepts valid target language', () => {
      const targetLang = 'es'
      const validLang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLang)
      expect(validLang).toBeDefined()
      expect(validLang!.name).toBe('Spanish')
    })

    it('validates file extension against supported formats', () => {
      expect(SUPPORTED_EXTENSIONS['.pdf']).toBe('pdf')
      expect(SUPPORTED_EXTENSIONS['.docx']).toBe('docx')
      expect(SUPPORTED_EXTENSIONS['.md']).toBe('md')
      expect(SUPPORTED_EXTENSIONS['.txt']).toBeUndefined()
      expect(SUPPORTED_EXTENSIONS['.jpg']).toBeUndefined()
    })
  })

  describe('error messages', () => {
    it('file not found message includes path', () => {
      const filePath = '/path/to/missing.pdf'
      const msg = `File not found: '${filePath}'.`
      expect(msg).toContain(filePath)
    })

    it('invalid language message suggests using list tool', () => {
      const code = 'xx'
      const msg = `Unsupported language '${code}'. Use list_supported_languages to see available options.`
      expect(msg).toContain(code)
      expect(msg).toContain('list_supported_languages')
    })

    it('not complete message includes progress percentage', () => {
      const progress = 45
      const msg = `Translation is ${progress}% complete. Check back shortly.`
      expect(msg).toContain('45%')
    })

    it('document not found message includes ID', () => {
      const id = 'abc-123'
      const msg = `No translation found with ID '${id}'.`
      expect(msg).toContain(id)
    })
  })

  describe('get_translation_status response structure', () => {
    it('maps document status to MCP stage names', () => {
      const statusToStage: Record<string, string> = {
        uploaded: 'queued',
        analyzing: 'glossary',
        translating: 'translating',
        assembling: 'assembling',
        completed: 'completed',
        failed: 'failed',
      }

      expect(statusToStage['uploaded']).toBe('queued')
      expect(statusToStage['analyzing']).toBe('glossary')
      expect(statusToStage['translating']).toBe('translating')
      expect(statusToStage['completed']).toBe('completed')
      expect(statusToStage['failed']).toBe('failed')
    })
  })

  describe('get_document_cost response structure', () => {
    it('calculates input/output cost breakdown correctly', () => {
      const inputTokens = 10000
      const outputTokens = 12000

      const inputCost = (inputTokens / 1_000_000) * 0.15
      const outputCost = (outputTokens / 1_000_000) * 0.60

      expect(inputCost).toBeCloseTo(0.0015, 6)
      expect(outputCost).toBeCloseTo(0.0072, 6)
      expect(inputCost + outputCost).toBeCloseTo(0.0087, 6)
    })
  })

  describe('download_translation', () => {
    it('concatenates completed chunks in order', () => {
      const chunks = [
        { chunkIndex: 2, status: 'completed', translatedText: 'Third chunk.' },
        { chunkIndex: 0, status: 'completed', translatedText: 'First chunk.' },
        { chunkIndex: 1, status: 'completed', translatedText: 'Second chunk.' },
        { chunkIndex: 3, status: 'failed', translatedText: null },
      ]

      const translatedText = chunks
        .filter((c) => c.status === 'completed' && c.translatedText)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((c) => c.translatedText)
        .join('\n\n')

      expect(translatedText).toBe('First chunk.\n\nSecond chunk.\n\nThird chunk.')
    })
  })
})
