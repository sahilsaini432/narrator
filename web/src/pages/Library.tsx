import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Book } from '../api'
import PhotoSheet from '../PhotoSheet'

function timeAgo(ts: number | null): string {
  if (!ts) return 'Not started'
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ts * 1000).toLocaleDateString()
}

interface Props {
  onOpen: (id: number) => void
  onManage: (id: number) => void
  onStorage: () => void
}

export default function Library({ onOpen, onManage, onStorage }: Props) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState<string | null>(null)
  const [photoSheet, setPhotoSheet] = useState(false)
  const [openForm, setOpenForm] = useState<'link' | 'text' | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pasteTitle, setPasteTitle] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    api
      .books()
      .then((b) => {
        setBooks(b)
        setError('')
      })
      .catch(() => setError("Can't reach the Narrator server. Is it running on your PC?"))
  }, [])

  useEffect(refresh, [refresh])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setError('')
    for (const file of Array.from(files)) {
      setUploading(file.name)
      try {
        await api.upload(file)
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`)
      }
    }
    setUploading(null)
    if (fileInput.current) fileInput.current.value = ''
    refresh()
  }

  async function onAddUrl(e: React.FormEvent) {
    e.preventDefault()
    const url = linkUrl.trim()
    if (!url) return
    setError('')
    setUploading(url)
    try {
      await api.addUrl(url)
      setLinkUrl('')
      setOpenForm(null)
    } catch (err) {
      setError(`${url}: ${(err as Error).message}`)
    }
    setUploading(null)
    refresh()
  }

  async function onAddText(e: React.FormEvent) {
    e.preventDefault()
    if (!pasteText.trim()) return
    const label = pasteTitle.trim() || 'pasted text'
    setError('')
    setUploading(label)
    try {
      await api.addText(pasteText, pasteTitle.trim())
      setPasteText('')
      setPasteTitle('')
      setOpenForm(null)
    } catch (err) {
      setError(`${label}: ${(err as Error).message}`)
    }
    setUploading(null)
    refresh()
  }

  const toggleForm = (form: 'link' | 'text') => setOpenForm((cur) => (cur === form ? null : form))

  async function remove(book: Book) {
    if (!window.confirm(`Delete "${book.title}"? Its saved place and audio will be removed.`)) return
    await api.remove(book.id).catch(() => setError('Could not delete that book.'))
    refresh()
  }

  return (
    <main className="screen">
      <header className="topbar">
        <h1>Library</h1>
        <button className="btn" onClick={() => toggleForm('text')} disabled={!!uploading}>
          Text
        </button>
        <button className="btn" onClick={() => toggleForm('link')} disabled={!!uploading}>
          Link
        </button>
        <button className="btn" onClick={() => setPhotoSheet(true)} disabled={!!uploading}>
          Photos
        </button>
        <button className="btn primary" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
          {uploading ? 'Adding…' : '+ Add'}
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          onChange={(e) => onFiles(e.target.files)}
        />
      </header>

      {openForm === 'text' && (
        <form className="paste-form" onSubmit={onAddText}>
          <input
            type="text"
            placeholder="Title (optional)"
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            maxLength={200}
            disabled={!!uploading}
          />
          <textarea
            autoFocus
            rows={8}
            placeholder="Paste text to listen to"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            disabled={!!uploading}
          />
          <button className="btn primary" type="submit" disabled={!!uploading || !pasteText.trim()}>
            Add
          </button>
        </form>
      )}

      {openForm === 'link' && (
        <form className="link-form" onSubmit={onAddUrl}>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            placeholder="Paste a web page address"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            disabled={!!uploading}
          />
          <button className="btn primary" type="submit" disabled={!!uploading || !linkUrl.trim()}>
            Add
          </button>
        </form>
      )}

      {uploading && <p className="notice">Reading “{uploading}”…</p>}
      {error && <p className="notice error">{error}</p>}

      {books && books.length === 0 && !error && (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="muted">Add a PDF, EPUB, web page link, pasted text or photos of a printed book and Narrator will read it to you.</p>
        </div>
      )}

      <ul className="books">
        {books?.map((b) => {
          const pct = Math.round(((b.page - 1) / Math.max(b.page_count, 1)) * 100)
          return (
            <li key={b.id} className="book">
              <button className="book-main" onClick={() => (b.page_count === 0 ? onManage(b.id) : onOpen(b.id))}>
                <span className={`badge ${b.format}`}>{b.format.toUpperCase()}</span>
                <span className="book-text">
                  <span className="book-title">{b.title}</span>
                  {b.author && <span className="book-author">{b.author}</span>}
                  <span className="book-meta">
                    Page {b.page} of {b.page_count} · {timeAgo(b.last_opened_at)}
                  </span>
                  <span className="bar">
                    <span style={{ width: `${pct}%` }} />
                  </span>
                </span>
              </button>
              <button className="icon-btn" aria-label={`Pages of ${b.title}`} onClick={() => onManage(b.id)}>
                ☰
              </button>
              <button className="icon-btn" aria-label={`Delete ${b.title}`} onClick={() => remove(b)}>
                ✕
              </button>
            </li>
          )
        })}
      </ul>

      <footer className="lib-footer">
        <button className="link-btn" onClick={onStorage}>
          Storage &amp; cleanup
        </button>
      </footer>

      {photoSheet && (
        <PhotoSheet
          folders={(books ?? []).filter((b) => b.format === 'photos')}
          onClose={() => setPhotoSheet(false)}
          onChanged={refresh}
        />
      )}
    </main>
  )
}
