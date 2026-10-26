export interface Book {
  id: number
  title: string
  author: string
  format: 'pdf' | 'epub' | 'web' | 'photos' | 'text'
  page_count: number
  added_at: number
  last_opened_at: number | null
  page: number
  offset_seconds: number
  progress_updated_at: number
}

export interface PageInfo {
  n: number
  text: string
  has_image: boolean
}

export interface StorageInfo {
  audio_total: number
  books: {
    id: number
    title: string
    format: Book['format']
    page_count: number
    file_bytes: number
    audio_bytes: number
  }[]
}

export interface Voice {
  id: string
  label: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* not JSON */
    }
    throw new Error(detail)
  }
  return res.json()
}

export const api = {
  books: () => fetch('/api/books').then(json<Book[]>),
  book: (id: number) => fetch(`/api/books/${id}`).then(json<Book>),
  upload: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return fetch('/api/books', { method: 'POST', body }).then(json<Book>)
  },
  addUrl: (url: string) =>
    fetch('/api/books/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(json<Book>),
  addText: (text: string, title: string) =>
    fetch('/api/books/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title }),
    }).then(json<Book>),
  createFolder: (title: string) =>
    fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json<Book>),
  addPhoto: (id: number, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return fetch(`/api/books/${id}/photos`, { method: 'POST', body }).then(json<Book>)
  },
  rename: (id: number, title: string) =>
    fetch(`/api/books/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json<Book>),
  pages: (id: number) => fetch(`/api/books/${id}/pages`).then(json<PageInfo[]>),
  editPage: (id: number, n: number, text: string) =>
    fetch(`/api/books/${id}/pages/${n}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(json<{ ok: true }>),
  deletePage: (id: number, n: number) =>
    fetch(`/api/books/${id}/pages/${n}`, { method: 'DELETE' }).then(json<Book>),
  movePage: (id: number, n: number, to: number) =>
    fetch(`/api/books/${id}/pages/${n}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    }).then(json<{ ok: true }>),
  imageUrl: (id: number, n: number, v = 0) => `/api/books/${id}/pages/${n}/image?v=${v}`,
  storage: () => fetch('/api/storage').then(json<StorageInfo>),
  clearBookAudio: (id: number) => fetch(`/api/books/${id}/audio`, { method: 'DELETE' }).then(json<{ ok: true }>),
  clearAllAudio: () => fetch('/api/audio', { method: 'DELETE' }).then(json<{ ok: true }>),
  remove: (id: number) => fetch(`/api/books/${id}`, { method: 'DELETE' }).then(json<{ ok: true }>),
  pageText: (id: number, n: number) =>
    fetch(`/api/books/${id}/pages/${n}`).then(json<{ page: number; text: string }>),
  audioUrl: (id: number, n: number, voice: string) =>
    `/api/books/${id}/pages/${n}/audio?voice=${encodeURIComponent(voice)}`,
  voices: () => fetch('/api/voices').then(json<{ default: string; voices: Voice[] }>),
}

// Progress is mirrored to localStorage so a dropped connection never loses your place.
const localKey = (id: number) => `narrator:progress:${id}`

export function saveProgress(id: number, page: number, offset: number) {
  try {
    localStorage.setItem(localKey(id), JSON.stringify({ page, offset, at: Date.now() }))
  } catch {
    /* storage unavailable */
  }
  fetch(`/api/books/${id}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, offset_seconds: offset }),
    keepalive: true,
  }).catch(() => {})
}

export function loadProgress(book: Book) {
  try {
    const raw = localStorage.getItem(localKey(book.id))
    if (raw) {
      const local = JSON.parse(raw) as { page: number; offset: number; at: number }
      // Use the local copy only if it is newer than what the server holds.
      if (local.at / 1000 > (book.progress_updated_at ?? 0)) {
        return { page: local.page, offset: local.offset }
      }
    }
  } catch {
    /* ignore */
  }
  return { page: book.page || 1, offset: book.offset_seconds || 0 }
}
