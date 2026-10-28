import React from 'react'

const STAGE_LABELS = {
  queued: 'Queued',
  glossary: 'Extracting glossary…',
  translating: 'Translating content…',
  assembling: 'Assembling document…',
  completed: 'Complete',
  failed: 'Failed',
}

function qualityBadge(score) {
  if (score == null) return null
  const num = parseFloat(score)
  if (isNaN(num)) return null

  let color, label
  if (num >= 0.75) { color = 'var(--stark-green)'; label = 'High confidence' }
  else if (num >= 0.50) { color = 'var(--stark-orange)'; label = 'Acceptable' }
  else { color = 'var(--stark-red)'; label = 'Low confidence' }

  return (
    <span className="quality-badge" title={label}>
      <span className="quality-dot" style={{ background: color }} />
      {num.toFixed(2)}
    </span>
  )
}

function formatCost(cost) {
  if (!cost) return '$0.00'
  const num = parseFloat(cost)
  if (isNaN(num) || num === 0) return '$0.00'
  return `$${num.toFixed(num < 0.01 ? 4 : 2)}`
}

function formatDuration(ms) {
  if (!ms) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function TranslationCard({
  id, name, type, from, to, progress, status, stage, detail,
  completedChunks, totalChunks,
  costSoFar, qualityScore, totalDurationMs, errorCode, errorMessage,
  onCancel, onDownload,
}) {
  const stageLabel = STAGE_LABELS[stage] || STAGE_LABELS[status] || status
  const isActive = status !== 'completed' && status !== 'failed'
  const isFailed = status === 'failed'
  const isComplete = status === 'completed'

  return (
    <div className={`translation-card ${isFailed ? 'error' : ''}`}>
      <div className="translation-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className={`file-card-icon ${type}`} style={{ width: 36, height: 36, borderRadius: 8, fontSize: 10 }}>
            {type}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
            <div style={{ fontSize: 12, color: 'var(--stark-text-dim)', marginTop: 2 }}>
              {from} → {to}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="translation-status">
            <span className={`dot ${isActive ? 'processing' : isComplete ? 'complete' : 'error'}`} />
            {stageLabel}
          </div>
          <div className="translation-pct">{progress || 0}%</div>
        </div>
      </div>

      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${progress || 0}%` }} />
      </div>

      {isFailed && errorMessage && (
        <div className="translation-error">
          {errorCode === 'CANCELLED' ? '⊘ ' : '⚠ '}
          {errorMessage}
        </div>
      )}

      {!isFailed && detail && <div className="translation-detail">{detail}</div>}

      {/* Stats row: cost, duration, quality */}
      {(isComplete || costSoFar) && (
        <div className="translation-stats">
          <span>Cost: {formatCost(costSoFar)}</span>
          {totalDurationMs && <span>Time: {formatDuration(totalDurationMs)}</span>}
          {isComplete && qualityScore != null && (
            <span>Quality: {qualityBadge(qualityScore)}</span>
          )}
        </div>
      )}

      <div className="translation-actions">
        {isActive && onCancel && (
          <button className="cancel-btn" onClick={() => onCancel(id)}>Cancel</button>
        )}
        {isComplete && onDownload && (
          <button className="download-btn" onClick={() => onDownload(id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            Download
          </button>
        )}
      </div>
    </div>
  )
}
