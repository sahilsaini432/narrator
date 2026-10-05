// Lock-screen / Control Center / headphone controls via the Media Session API.
// iOS shows either skip-back/forward buttons or previous/next-track buttons, never both.
// We register seekbackward/seekforward only, so the lock screen shows -15s / +15s.

export const SKIP_SECONDS = 15

export interface MediaHandlers {
  play: () => void
  pause: () => void
  seekBy: (delta: number) => void
  seekTo: (time: number) => void
}

const ms = () => ('mediaSession' in navigator ? navigator.mediaSession : null)

export function setMetadata(title: string, author: string, album: string) {
  const s = ms()
  if (!s) return
  s.metadata = new MediaMetadata({
    title,
    artist: author || 'Narrator',
    album,
    artwork: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  })
}

export function setPlaybackState(state: 'playing' | 'paused' | 'none') {
  const s = ms()
  if (s) s.playbackState = state
}

export function setPosition(duration: number, position: number, rate: number) {
  const s = ms()
  if (!s || !Number.isFinite(duration) || duration <= 0) return
  try {
    s.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate: rate,
    })
  } catch {
    /* some browsers throw on transient invalid values */
  }
}

export function registerHandlers(h: MediaHandlers) {
  const s = ms()
  if (!s) return () => {}
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      s.setActionHandler(action, fn)
    } catch {
      /* action unsupported */
    }
  }
  set('play', () => h.play())
  set('pause', () => h.pause())
  set('seekbackward', (d) => h.seekBy(-(d.seekOffset ?? SKIP_SECONDS)))
  set('seekforward', (d) => h.seekBy(d.seekOffset ?? SKIP_SECONDS))
  set('seekto', (d) => {
    if (d.seekTime != null) h.seekTo(d.seekTime)
  })
  set('previoustrack', null)
  set('nexttrack', null)
  return () => {
    for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'] as const) set(a, null)
    setPlaybackState('none')
  }
}
