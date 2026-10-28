import React from 'react'

const LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'ar', label: 'Arabic' },
]

const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== 'auto')

export default function LanguageSelector({ source, target, onSourceChange, onTargetChange }) {
  return (
    <div className="language-row">
      <select
        className="language-select"
        value={source}
        onChange={(e) => onSourceChange(e.target.value)}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>

      <div className="language-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </div>

      <select
        className="language-select"
        value={target}
        onChange={(e) => onTargetChange(e.target.value)}
      >
        {TARGET_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </div>
  )
}
