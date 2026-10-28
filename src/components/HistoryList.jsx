import React from 'react'

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function qualityDot(score) {
  if (score == null) return null
  const num = parseFloat(score)
  if (isNaN(num)) return null
  let color
  if (num >= 0.75) color = 'var(--stark-green)'
  else if (num >= 0.50) color = 'var(--stark-orange)'
  else color = 'var(--stark-red)'
  return <span className="quality-dot-small" style={{ background: color }} title={`Quality: ${num.toFixed(2)}`} />
}

export default function HistoryList({ items, onDownload }) {
  if (!items || items.length === 0) {
    return <div className="empty-state">No translations yet. Upload a document to get started.</div>
  }

  return (
    <div>
      {items.map((item) => (
        <div key={item.id} className="history-item">
          <div className="history-lang">
            {(item.sourceLanguage || 'EN').toUpperCase()}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            {(item.targetLanguage || '').toUpperCase()}
          </div>
          <div className="history-name">
            {qualityDot(item.qualityScore)}
            {item.name}
          </div>
          <div className="history-time">{timeAgo(item.completedAt || item.createdAt)}</div>
          {item.status === 'completed' && onDownload && (
            <button className="download-btn" onClick={() => onDownload(item.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Download
            </button>
          )}
          {item.status === 'failed' && (
            <span className="history-status-badge failed">Failed</span>
          )}
        </div>
      ))}
    </div>
  )
}
