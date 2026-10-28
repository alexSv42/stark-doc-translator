export type DocumentStatus = 'uploaded' | 'analyzing' | 'translating' | 'assembling' | 'completed' | 'failed'
export type ChunkStatus = 'pending' | 'translating' | 'completed' | 'failed' | 'skipped'
export type SupportedFormat = 'pdf' | 'docx' | 'md'

export const SUPPORTED_FORMATS: SupportedFormat[] = ['pdf', 'docx', 'md']

export const SUPPORTED_EXTENSIONS: Record<string, SupportedFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'md',
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ar', name: 'Arabic' },
] as const

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number]['code']

export interface DocumentRow {
  id: string
  originalName: string
  storagePath: string
  outputPath: string | null
  format: SupportedFormat
  fileSizeBytes: number
  pageCount: number | null
  status: DocumentStatus
  sourceLanguage: string | null
  targetLanguage: string
  errorCode: string | null
  errorMessage: string | null
  totalChunks: number | null
  completedChunks: number
  totalCostUsd: string
  totalInputTokens: number
  totalOutputTokens: number
  qualityScore: string | null
  parseDurationMs: number | null
  translateDurationMs: number | null
  assembleDurationMs: number | null
  totalDurationMs: number | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}
