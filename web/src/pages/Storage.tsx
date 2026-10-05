import { useCallback, useEffect, useState } from 'react'
import { api, type StorageInfo } from '../api'

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function Storage({ onBack, onOpen }: { onBack: () => void; onOpen: (id: number) => void }) {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api
      .storage()
      .then((s) => {
        setInfo(s)
        setError('')
      })
      .catch(() => setError("Can't reach the Narrator server."))
  }, [])

  useEffect(refresh, [refresh])

  async function act(action: () => Promise<unknown>) {
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    }
    refresh()
  }

  const totalFiles = info?.books.reduce((n, b) => n + b.file_bytes, 0) ?? 0

  return (
    <main className="screen">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ Library
        </button>
        <h1>Storage</h1>
      </header>

      {error && <p className="notice error">{error}</p>}

      {info && (
        <>
          <section className="summary">
            <div>
              <strong>{size(info.audio_total)}</strong>
              <span className="muted"> of cached audio</span>
              <p className="muted hint">
                Audio is regenerated the next time you play a page, so clearing it only costs a short wait.
              </p>
            </div>
            <button
              className="btn"
              disabled={info.audio_total === 0}
              onClick={() => window.confirm('Clear all cached audio?') && act(api.clearAllAudio)}
            >
              Clear all audio
            </button>
          </section>

          <p className="muted hint">Originals (PDFs, EPUBs, photos): {size(totalFiles)}</p>

          <ul className="books">
            {info.books.length === 0 && <li className="muted">Nothing saved yet.</li>}
            {info.books.map((b) => (
              <li key={b.id} className="book storage-row">
                <button className="book-main" onClick={() => onOpen(b.id)}>
                  <span className={`badge ${b.format}`}>{b.format.toUpperCase()}</span>
                  <span className="book-text">
                    <span className="book-title">{b.title}</span>
                    <span className="book-meta">
                      {b.page_count} page{b.page_count === 1 ? '' : 's'} · audio {size(b.audio_bytes)}
                      {b.file_bytes > 0 && ` · file ${size(b.file_bytes)}`}
                    </span>
                  </span>
                </button>
                <button
                  className="btn small"
                  disabled={b.audio_bytes === 0}
                  onClick={() => act(() => api.clearBookAudio(b.id))}
                >
                  Clear audio
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Delete ${b.title}`}
                  onClick={() =>
                    window.confirm(`Delete "${b.title}"? Its pages, photos, saved place and audio will be removed.`) &&
                    act(() => api.remove(b.id))
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
