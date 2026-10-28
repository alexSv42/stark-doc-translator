import React from 'react'

export default function FileCard({ name, size, type, onRemove }) {
  return (
    <div className="file-card">
      <div className={`file-card-icon ${type}`}>{type}</div>
      <div className="file-card-info">
        <div className="file-card-name">{name}</div>
        <div className="file-card-meta">{size}</div>
      </div>
      <button className="file-card-remove" onClick={onRemove} title="Remove file">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
