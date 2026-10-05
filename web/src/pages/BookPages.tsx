import { useCallback, useEffect, useState } from 'react'
import { api, type Book, type PageInfo } from '../api'
import PhotoSheet from '../PhotoSheet'

interface Props {
  bookId: number
  onBack: () => void
  onPlay: () => void
}

export default function BookPages({ bookId, onBack, onPlay }: Props) {
  const [book, setBook] = useState<Book | null>(null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  const [sheet, setSheet] = useState(false)
  const [version, setVersion] = useState(0) // busts the image cache after reordering

  const refresh = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([api.book(bookId), api.pages(bookId)])
      setBook(b)
      setPages(p)
      setVersion((v) => v + 1)
      setError('')
    } catch (e) {
      setError((e as Error).message || 'Could not load this book.')
    }
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
    await refresh()
  }

  const startEdit = (p: PageInfo) => {
    setEditing(p.n)
    setDraft(p.text)
  }

  async function saveEdit() {
    if (editing == null) return
    await run(() => api.editPage(bookId, editing, draft))
    setEditing(null)
  }

  async function removePage(p: PageInfo) {
    if (!window.confirm(`Delete page ${p.n}? This can't be undone.`)) return
    if (editing === p.n) setEditing(null)
    await run(() => api.deletePage(bookId, p.n))
  }

  async function saveTitle() {
    const t = title.trim()
    setRenaming(false)
    if (t && book && t !== book.title) await run(() => api.rename(bookId, t))
  }

  if (!book) {
    return (
      <main className="screen">
        <header className="topbar">
          <button className="btn" onClick={onBack}>
            ‹ Library
          </button>
        </header>
        {error ? <p className="notice error">{error}</p> : <p className="notice">Loading…</p>}
      </main>
    )
  }

  const isPhotos = book.format === 'photos'

  return (
    <main className="screen">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ Library
        </button>
        <div className="titles grow">
          {renaming ? (
            <input
              className="text-input"
              value={title}
              autoFocus
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <button
              className="title-btn"
              onClick={() => {
                setTitle(book.title)
                setRenaming(true)
              }}
              aria-label="Rename"
            >
              <span className="book-title">{book.title} ✎</span>
            </button>
          )}
          <span className="book-author">
            {book.page_count} page{book.page_count === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <div className="row-actions">
        {isPhotos && (
          <button className="btn primary" onClick={() => setSheet(true)}>
            + Add photos
          </button>
        )}
        <button className="btn" onClick={onPlay} disabled={book.page_count === 0}>
          ▶ Listen
        </button>
      </div>

      {error && <p className="notice error">{error}</p>}

      {pages.length === 0 && !error && (
        <div className="empty">
          <p>No pages yet.</p>
          {isPhotos && <p className="muted">Tap “Add photos” to photograph the first page.</p>}
        </div>
      )}

      <ul className="page-list">
        {pages.map((p) => (
          <li key={p.n} className="page-row">
            <div className="page-head">
              {p.has_image && (
                <a href={api.imageUrl(bookId, p.n, version)} target="_blank" rel="noreferrer" aria-label={`View photo of page ${p.n}`}>
                  <img className="thumb" loading="lazy" src={api.imageUrl(bookId, p.n, version)} alt="" />
                </a>
              )}
              <div className="page-body">
                <span className="page-num">Page {p.n}</span>
                {editing === p.n ? (
                  <>
                    <textarea
                      className="text-area"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={10}
                    />
                    <div className="row-actions">
                      <button className="btn primary" onClick={saveEdit} disabled={!draft.trim()}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <span className="page-preview">{p.text}</span>
                )}
              </div>
            </div>
            {editing !== p.n && (
              <div className="page-tools">
                <button
                  className="icon-btn"
                  aria-label={`Move page ${p.n} up`}
                  disabled={p.n === 1}
                  onClick={() => run(() => api.movePage(bookId, p.n, p.n - 1))}
                >
                  ▲
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Move page ${p.n} down`}
                  disabled={p.n === pages.length}
                  onClick={() => run(() => api.movePage(bookId, p.n, p.n + 1))}
                >
                  ▼
                </button>
                <button className="icon-btn" aria-label={`Edit page ${p.n}`} onClick={() => startEdit(p)}>
                  ✎
                </button>
                <button className="icon-btn" aria-label={`Delete page ${p.n}`} onClick={() => removePage(p)}>
                  ✕
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {sheet && <PhotoSheet folders={[]} fixed={book} onClose={() => setSheet(false)} onChanged={refresh} />}
    </main>
  )
}
