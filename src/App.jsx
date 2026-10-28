import React, { useState, useCallback, useEffect, useRef } from 'react'
import UploadZone from './components/UploadZone'
import FileCard from './components/FileCard'
import LanguageSelector from './components/LanguageSelector'
import TranslationCard from './components/TranslationCard'
import HistoryList from './components/HistoryList'

const API = '/api/documents'

function App() {
  const [files, setFiles] = useState([])
  const [sourceLang, setSourceLang] = useState('auto')
  const [targetLang, setTargetLang] = useState('es')
  const [translations, setTranslations] = useState([])
  const [history, setHistory] = useState([])
  const [uploading, setUploading] = useState(false)
  const sseRefs = useRef({})

  // Load history + restore in-progress translations on mount
  useEffect(() => {
    loadDocuments()
  }, [])

  async function loadDocuments() {
    try {
      const res = await fetch(API)
      if (!res.ok) return
      const data = await res.json()

      const terminal = data.filter((d) => d.status === 'completed' || d.status === 'failed')
      setHistory(terminal)

      // Restore documents that were still in progress (e.g. after container restart)
      const active = data.filter((d) =>
        d.status === 'uploaded' || d.status === 'analyzing' ||
        d.status === 'translating' || d.status === 'assembling'
      )
      if (active.length > 0) {
        const restored = active.map((d) => ({
          id: d.id,
          documentId: d.id,
          name: d.name,
          type: (d.format || d.name?.split('.').pop() || 'pdf').toLowerCase(),
          from: d.sourceLanguage ? d.sourceLanguage.toUpperCase() : 'AUTO',
          to: d.targetLanguage ? d.targetLanguage.toUpperCase() : 'ES',
          progress: 0,
          status: d.status,
          stage: mapStatusToStage(d.status),
          detail: stageDetail(mapStatusToStage(d.status), d),
          costSoFar: d.totalCostUsd,
          completedChunks: d.completedChunks,
          totalChunks: d.totalChunks,
          qualityScore: null,
          totalDurationMs: null,
        }))

        // Merge restored docs without duplicating ones already tracked
        setTranslations((prev) => {
          const existing = new Set(prev.map((t) => t.documentId))
          const newOnes = restored.filter((r) => !existing.has(r.documentId))
          return [...newOnes, ...prev]
        })

        // Connect SSE for each restored doc to get live progress updates
        for (const d of active) {
          if (!sseRefs.current[d.id]) {
            connectSSE(d.id)
          }
        }
      }
    } catch { /* backend not reachable */ }
  }

  function loadHistory() {
    loadDocuments()
  }

  function mapStatusToStage(status) {
    switch (status) {
      case 'uploaded': return 'queued'
      case 'analyzing': return 'glossary'
      case 'translating': return 'translating'
      case 'assembling': return 'assembling'
      case 'completed': return 'completed'
      case 'failed': return 'failed'
      default: return 'unknown'
    }
  }

  const handleFiles = useCallback((accepted) => {
    const newFiles = accepted.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      name: f.name,
      size: f.size,
      type: f.name.split('.').pop().toLowerCase(),
    }))
    setFiles((prev) => [...prev, ...newFiles])
  }, [])

  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id))

  function connectSSE(documentId, translation) {
    // Close any existing connection for this doc
    if (sseRefs.current[documentId]) {
      sseRefs.current[documentId].close()
    }

    const evtSource = new EventSource(`${API}/${documentId}/events`)
    sseRefs.current[documentId] = evtSource

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        const stage = data.stage || data.status
        setTranslations((prev) =>
          prev.map((t) => {
            if (t.documentId !== documentId) return t
            return {
              ...t,
              status: data.status,
              stage,
              progress: data.progress || 0,
              completedChunks: data.completedChunks,
              totalChunks: data.totalChunks,
              costSoFar: data.costSoFar || data.totalCostUsd,
              qualityScore: data.qualityScore,
              totalDurationMs: data.totalDurationMs,
              errorCode: data.errorCode,
              errorMessage: data.errorMessage,
              detail: data.errorMessage || stageDetail(stage, data),
            }
          })
        )

        if (data.status === 'completed' || data.status === 'failed') {
          evtSource.close()
          delete sseRefs.current[documentId]
          // Remove from active translations — loadHistory will add to history list
          setTranslations((prev) => prev.filter((t) => t.documentId !== documentId))
          loadHistory()
        }
      } catch { /* ignore parse errors */ }
    }

    evtSource.onerror = () => {
      evtSource.close()
      delete sseRefs.current[documentId]
      // Retry SSE after a delay (API might be restarting)
      setTimeout(() => {
        // Only reconnect if the translation is still active in state
        setTranslations((prev) => {
          const t = prev.find((t) => t.documentId === documentId)
          if (t && t.status !== 'completed' && t.status !== 'failed') {
            connectSSE(documentId)
          }
          return prev
        })
      }, 3000)
    }
  }

  function stageDetail(stage, data) {
    switch (stage) {
      case 'queued': return 'Queued for processing…'
      case 'glossary': return 'Analyzing document and extracting glossary…'
      case 'translating': {
        const done = data?.completedChunks || 0
        const total = data?.totalChunks || 0
        return total > 0 ? `Translating chunk ${done} of ${total}…` : 'Translating content…'
      }
      case 'assembling': return 'Assembling translated document…'
      case 'completed': return 'Translation complete — ready to download'
      case 'failed': return 'Translation failed'
      default: return 'Processing…'
    }
  }

  const handleTranslate = async () => {
    if (files.length === 0 || uploading) return
    setUploading(true)

    const newTranslations = []

    for (const f of files) {
      try {
        // 1. Upload
        const formData = new FormData()
        formData.append('file', f.file)
        formData.append('targetLanguage', targetLang)
        if (sourceLang !== 'auto') formData.append('sourceLanguage', sourceLang)

        const uploadRes = await fetch(`${API}/upload`, { method: 'POST', body: formData })
        if (!uploadRes.ok) {
          const err = await uploadRes.json().catch(() => ({}))
          newTranslations.push({
            id: f.id,
            documentId: null,
            name: f.name,
            type: f.type,
            from: sourceLang === 'auto' ? 'AUTO' : sourceLang.toUpperCase(),
            to: targetLang.toUpperCase(),
            progress: 0,
            status: 'failed',
            stage: 'failed',
            errorCode: err.error?.code || 'UPLOAD_FAILED',
            errorMessage: err.error?.message || 'Upload failed',
            detail: err.error?.message || 'Upload failed',
          })
          continue
        }

        const doc = await uploadRes.json()

        // 2. Trigger translation
        const transRes = await fetch(`${API}/${doc.id}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetLanguage: targetLang, sourceLanguage: sourceLang !== 'auto' ? sourceLang : undefined }),
        })

        const translation = {
          id: f.id,
          documentId: doc.id,
          name: f.name,
          type: f.type,
          from: sourceLang === 'auto' ? 'AUTO' : sourceLang.toUpperCase(),
          to: targetLang.toUpperCase(),
          progress: 0,
          status: 'uploaded',
          stage: 'queued',
          detail: 'Queued for processing…',
          costSoFar: null,
          qualityScore: null,
          totalDurationMs: null,
        }

        newTranslations.push(translation)

        // 3. Connect SSE
        connectSSE(doc.id, translation)
      } catch (err) {
        newTranslations.push({
          id: f.id,
          documentId: null,
          name: f.name,
          type: f.type,
          from: sourceLang === 'auto' ? 'AUTO' : sourceLang.toUpperCase(),
          to: targetLang.toUpperCase(),
          progress: 0,
          status: 'failed',
          stage: 'failed',
          errorMessage: err.message || 'Network error',
          detail: err.message || 'Network error',
        })
      }
    }

    setTranslations((prev) => [...newTranslations, ...prev])
    setFiles([])
    setUploading(false)
  }

  const handleCancel = async (id) => {
    const t = translations.find((t) => t.id === id)
    if (!t?.documentId) return

    try {
      await fetch(`${API}/${t.documentId}/cancel`, { method: 'POST' })
      setTranslations((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, status: 'failed', stage: 'failed', errorCode: 'CANCELLED', errorMessage: 'Translation cancelled by user.', detail: 'Cancelled' } : x
        )
      )
      if (sseRefs.current[t.documentId]) {
        sseRefs.current[t.documentId].close()
        delete sseRefs.current[t.documentId]
      }
    } catch { /* ignore */ }
  }

  const handleDownload = async (documentId) => {
    try {
      const res = await fetch(`${API}/${documentId}/download`)
      if (!res.ok) return

      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename="?([^"]+)"?/)
      const filename = match ? match[1] : `translated-${documentId}`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      Object.values(sseRefs.current).forEach((es) => es.close())
    }
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-nav-link active">Translator</span>
          <span className="header-nav-link">History</span>
          <span className="header-nav-link">API</span>
        </div>
        <a href="/" className="header-logo">
          <img src="/logo.png" alt="Stark" className="header-logo-img" />
        </a>
        <div className="header-right">
          <div className="header-status">
            <span className="header-status-dot" />
            Connected
          </div>
          <button className="header-icon-btn" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      <div className="main-content">
        <section className="upload-section">
          <div className="section-label">Upload Document</div>
          <UploadZone onFiles={handleFiles} />
          {files.map((f) => (
            <FileCard
              key={f.id}
              name={f.name}
              size={formatSize(f.size)}
              type={f.type}
              onRemove={() => removeFile(f.id)}
            />
          ))}
        </section>

        <section className="language-section">
          <div className="section-label">Translation</div>
          <LanguageSelector
            source={sourceLang}
            target={targetLang}
            onSourceChange={setSourceLang}
            onTargetChange={setTargetLang}
          />
          <div style={{ marginTop: 24 }}>
            <button
              className="translate-btn"
              disabled={files.length === 0 || uploading}
              onClick={handleTranslate}
            >
              {uploading ? (
                <span className="spinner" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              )}
              {uploading ? 'Uploading…' : `Translate ${files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Document'}`}
            </button>
          </div>
        </section>

        {translations.length > 0 && (
          <section className="upload-section">
            <div className="section-label">Active Translations</div>
            {translations.map((t) => (
              <TranslationCard
                key={t.id}
                {...t}
                onCancel={handleCancel}
                onDownload={() => handleDownload(t.documentId)}
              />
            ))}
          </section>
        )}

        <section className="history-section">
          <div className="section-label">Recent Translations</div>
          <HistoryList items={history} onDownload={handleDownload} />
        </section>
      </div>

      <footer className="footer">
        <span>© {new Date().getFullYear()} Stark Future — Document Translation Service</span>
        <span>Powered by OpenAI</span>
      </footer>
    </div>
  )
}

export default App
