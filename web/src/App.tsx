import { useEffect, useState } from 'react'
import BookPages from './pages/BookPages'
import Library from './pages/Library'
import Player from './pages/Player'
import Storage from './pages/Storage'

// Tiny hash router: "#/book/12" player, "#/book/12/pages" page manager, "#/storage" storage.
type Route = { name: 'library' } | { name: 'player'; id: number } | { name: 'pages'; id: number } | { name: 'storage' }

function parseRoute(): Route {
  const h = window.location.hash
  let m = h.match(/^#\/book\/(\d+)$/)
  if (m) return { name: 'player', id: Number(m[1]) }
  m = h.match(/^#\/book\/(\d+)\/pages$/)
  if (m) return { name: 'pages', id: Number(m[1]) }
  if (h === '#/storage') return { name: 'storage' }
  return { name: 'library' }
}

const go = (hash: string) => (window.location.hash = hash)

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute)

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  switch (route.name) {
    case 'player':
      return <Player key={route.id} bookId={route.id} onBack={() => go('')} onManage={() => go(`#/book/${route.id}/pages`)} />
    case 'pages':
      return <BookPages key={route.id} bookId={route.id} onBack={() => go('')} onPlay={() => go(`#/book/${route.id}`)} />
    case 'storage':
      return <Storage onBack={() => go('')} onOpen={(id) => go(`#/book/${id}/pages`)} />
    default:
      return (
        <Library
          onOpen={(id) => go(`#/book/${id}`)}
          onManage={(id) => go(`#/book/${id}/pages`)}
          onStorage={() => go('#/storage')}
        />
      )
  }
}
