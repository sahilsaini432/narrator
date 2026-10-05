import { useCallback, useEffect, useRef, useState } from 'react'
import { api, loadProgress, saveProgress, type Book, type Voice } from '../api'
import * as media from '../mediaSession'

// A single <audio> element lives for the whole app. iOS ties background/lock-screen
// playback to the element that was started by a tap, so we reuse it and only swap `src`.
const audio = new Audio()
audio.preload = 'auto'

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

const stored = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export default function Player({
  bookId,
  onBack,
  onManage,
}: {
  bookId: number
  onBack: () => void
  onManage: () => void
}) {
  const [book, setBook] = useState<Book | null>(null)
  const [page, setPage] = useState(1)
  const [text, setText] = useState('')
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(() => Number(stored('narrator:speed')) || 1)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voice, setVoice] = useState(() => stored('narrator:voice') || 'af_heart')
  const [jump, setJump] = useState('')

  // Mirrors of state for use inside long-lived audio event handlers.
  const bookRef = useRef<Book | null>(null)
  const pageRef = useRef(1)
  const voiceRef = useRef(voice)
  const speedRef = useRef(speed)
  const pendingOffset = useRef(0)

  const applyRate = () => {
    audio.defaultPlaybackRate = speedRef.current
    audio.playbackRate = speedRef.current
  }

  const load = useCallback((n: number, offset: number, autoplay: boolean) => {
    const b = bookRef.current
    if (!b || b.page_count === 0) return
    n = Math.min(Math.max(n, 1), b.page_count)
    pageRef.current = n
    pendingOffset.current = offset
    setPage(n)
    setError('')
    setBusy(true)
    setTime(offset)
    setDuration(0)
    setText('')
    audio.src = api.audioUrl(b.id, n, voiceRef.current)
    applyRate()
    audio.load()
    if (autoplay) audio.play().catch(() => setPlaying(false))
    else setPlaying(false)
    api
      .pageText(b.id, n)
      .then((t) => pageRef.current === n && setText(t.text))
      .catch(() => {})
    media.setMetadata(`Page ${n} of ${b.page_count}`, b.author, b.title)
    saveProgress(b.id, n, offset)
  }, [])

  const persist = useCallback(() => {
    const b = bookRef.current
    if (b && audio.getAttribute('src')) saveProgress(b.id, pageRef.current, audio.currentTime)
  }, [])

  // Load the book, its saved position, and the voice list.
  useEffect(() => {
    let cancelled = false
    api
      .book(bookId)
      .then((b) => {
        if (cancelled) return
        bookRef.current = b
        setBook(b)
        const p = loadProgress(b)
        load(p.page, p.offset, false)
      })
      .catch(() => !cancelled && setError('Could not open this book.'))
    api
      .voices()
      .then((v) => !cancelled && setVoices(v.voices))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [bookId, load])

  // Audio events + lock-screen controls.
  useEffect(() => {
    const on = (name: string, fn: () => void) => {
      audio.addEventListener(name, fn)
      return () => audio.removeEventListener(name, fn)
    }
    const offs = [
      on('loadedmetadata', () => {
        setDuration(audio.duration)
        applyRate()
        const off = pendingOffset.current
        if (off > 0 && off < audio.duration - 1) audio.currentTime = off
        pendingOffset.current = 0
      }),
      on('canplay', () => setBusy(false)),
      on('waiting', () => setBusy(true)),
      on('playing', () => {
        setBusy(false)
        setPlaying(true)
        media.setPlaybackState('playing')
      }),
      on('play', () => setPlaying(true)),
      on('pause', () => {
        setPlaying(false)
        media.setPlaybackState('paused')
        if (!audio.ended) persist() // "ended" moves to the next page and saves that instead
      }),
      on('timeupdate', () => {
        setTime(audio.currentTime)
        media.setPosition(audio.duration, audio.currentTime, audio.playbackRate)
      }),
      on('ended', () => {
        const b = bookRef.current
        if (b && pageRef.current < b.page_count) load(pageRef.current + 1, 0, true)
        else if (b) saveProgress(b.id, pageRef.current, 0)
      }),
      on('error', () => {
        if (!audio.getAttribute('src')) return
        setBusy(false)
        setPlaying(false)
        setError('Could not get audio for this page. Is the server running?')
      }),
    ]
    const unregister = media.registerHandlers({
      play: () => void audio.play().catch(() => {}),
      pause: () => audio.pause(),
      seekBy: (d) => {
        const t = audio.currentTime + d
        if (t >= audio.duration) audio.currentTime = audio.duration
        else audio.currentTime = Math.max(0, t)
      },
      seekTo: (t) => {
        audio.currentTime = t
      },
    })
    return () => {
      offs.forEach((off) => off())
      unregister()
      persist()
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [load, persist])

  // Save the position every 5 s while playing, and whenever the app is hidden.
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(persist, 5000)
    return () => window.clearInterval(id)
  }, [playing, persist])

  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && persist()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', persist)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', persist)
    }
  }, [persist])

  function togglePlay() {
    if (error) return load(pageRef.current, audio.currentTime || 0, true)
    if (audio.paused) audio.play().catch(() => setError('Playback was blocked. Tap play again.'))
    else audio.pause()
  }

  function skip(delta: number) {
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), audio.duration || 0)
  }

  function goto(n: number) {
    load(n, 0, playing)
  }

  function changeSpeed(v: number) {
    speedRef.current = v
    setSpeed(v)
    store('narrator:speed', String(v))
    applyRate()
  }

  function changeVoice(v: string) {
    voiceRef.current = v
    setVoice(v)
    store('narrator:voice', v)
    load(pageRef.current, 0, playing)
  }

  if (!book) {
    return (
      <main className="screen">
        <header className="topbar">
          <button className="btn" onClick={onBack}>
            ‹ Library
          </button>
        </header>
        {error ? <p className="notice error">{error}</p> : <p className="notice">Opening…</p>}
      </main>
    )
  }

  return (
    <main className="screen player">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ Library
        </button>
        <div className="titles">
          <span className="book-title">{book.title}</span>
          {book.author && <span className="book-author">{book.author}</span>}
        </div>
        <button className="icon-btn" onClick={onManage} aria-label="Pages and text">
          ☰
        </button>
      </header>

      <section className="reader" aria-live="off">
        {text ? (
          text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)
        ) : (
          <p className="muted">Loading page…</p>
        )}
      </section>

      <footer className="controls">
        {error && <p className="notice error">{error}</p>}
        <div className="status">
          <span>
            Page {page} of {book.page_count}
          </span>
          <span className="muted">{busy && !error ? 'Preparing audio…' : ''}</span>
        </div>

        <div className="seek">
          <span>{fmt(time)}</span>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.5}
            value={Math.min(time, duration || 1)}
            disabled={!duration}
            onChange={(e) => (audio.currentTime = Number(e.target.value))}
            aria-label="Seek"
          />
          <span>{fmt(duration)}</span>
        </div>

        <div className="transport">
          <button className="icon-btn big" onClick={() => goto(page - 1)} disabled={page <= 1} aria-label="Previous page">
            ⏮
          </button>
          <button className="icon-btn big" onClick={() => skip(-media.SKIP_SECONDS)} aria-label="Back 15 seconds">
            ↺15
          </button>
          <button className="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="icon-btn big" onClick={() => skip(media.SKIP_SECONDS)} aria-label="Forward 15 seconds">
            15↻
          </button>
          <button
            className="icon-btn big"
            onClick={() => goto(page + 1)}
            disabled={page >= book.page_count}
            aria-label="Next page"
          >
            ⏭
          </button>
        </div>

        <div className="options">
          <label>
            Speed
            <select value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <label>
            Voice
            <select value={voice} onChange={(e) => changeVoice(e.target.value)}>
              {(voices.length ? voices : [{ id: voice, label: voice }]).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const n = parseInt(jump, 10)
              if (n >= 1 && n <= book.page_count) goto(n)
              setJump('')
            }}
          >
            <label>
              Go to page
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={String(page)}
                value={jump}
                onChange={(e) => setJump(e.target.value)}
              />
            </label>
          </form>
        </div>
      </footer>
    </main>
  )
}
