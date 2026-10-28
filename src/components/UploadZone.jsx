import React, { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'

const ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/markdown': ['.md'],
}
const MAX_SIZE = 100 * 1024 * 1024

export default function UploadZone({ onFiles }) {
  const [error, setError] = useState(null)

  const onDrop = useCallback((accepted) => {
    setError(null)
    if (accepted.length > 0) onFiles(accepted)
  }, [onFiles])

  const onDropRejected = useCallback((rejections) => {
    for (const r of rejections) {
      const code = r.errors[0]?.code
      if (code === 'file-too-large') {
        const sizeMb = (r.file.size / (1024 * 1024)).toFixed(1)
        setError(`File is too large (max 100 MB). This file is ${sizeMb} MB.`)
      } else if (code === 'file-invalid-type') {
        setError(`"${r.file.name}" is not supported. Accepted: PDF, DOCX, MD.`)
      } else {
        setError(`Upload error: ${r.errors[0]?.message || 'Unknown error'}`)
      }
      break
    }
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: ACCEPT,
    maxSize: MAX_SIZE,
  })

  return (
    <>
      <div {...getRootProps()} className={`upload-zone ${isDragActive ? 'drag-active' : ''}`}>
        <input {...getInputProps()} />
        <div className="upload-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.5" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
        </div>
        <div className="upload-title">
          {isDragActive ? 'Drop files here' : <>Drop files or <span className="accent">browse</span></>}
        </div>
        <div className="upload-subtitle">PDF, DOCX, Markdown — up to 100 MB</div>
        <div className="upload-formats">
          <span className="format-badge">PDF</span>
          <span className="format-badge">DOCX</span>
          <span className="format-badge">MD</span>
        </div>
      </div>
      {error && <div className="upload-error">{error}</div>}
    </>
  )
}
