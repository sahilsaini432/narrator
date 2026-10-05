import { useRef, useState } from 'react'
import { api, type Book } from './api'

interface Props {
  /** Existing photo folders to choose from. Ignored when `fixed` is set. */
  folders: Book[]
  /** Add to this folder only (used from a folder's own screen). */
  fixed?: Book
  onClose: () => void
  /** Called after any page was added, so the caller can refresh. */
  onChanged: () => void
}

const NEW = -1

export default function PhotoSheet({ folders, fixed, onClose, onChanged }: Props) {
  const [target, setTarget] = useState<number>(fixed?.id ?? folders[0]?.id ?? NEW)
  const [newName, setNewName] = useState('')
  const [progress, setProgress] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  const gallery = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)

  const creating = !fixed && target === NEW
  const needsName = creating && !newName.trim()

  async function upload(files: FileList | null) {
    if (!files?.length) return
    const list = Array.from(files)
    setBusy(true)
    setErrors([])
    setDone('')
    let id = target
    let added = 0
    const failed: string[] = []
    try {
      if (creating) {
        const folder = await api.createFolder(newName.trim())
        id = folder.id
        setTarget(folder.id) // later photos in this session go into the same folder
        setNewName('')
      }
      for (let i = 0; i < list.length; i++) {
        setProgress(`Reading photo ${i + 1} of ${list.length}…`)
        try {
          await api.addPhoto(id, list[i])
          added++
        } catch (e) {
          failed.push(`Photo ${i + 1}: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      failed.push((e as Error).message)
    }
    setProgress('')
    setErrors(failed)
    if (added) setDone(`Added ${added} page${added === 1 ? '' : 's'}.`)
    setBusy(false)
    if (gallery.current) gallery.current.value = ''
    if (camera.current) camera.current.value = ''
    onChanged()
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-label="Add photos" onClick={(e) => e.stopPropagation()}>
        <h2>{fixed ? `Add photos to “${fixed.title}”` : 'Add photos'}</h2>

        {!fixed && (
          <fieldset className="folder-list" disabled={busy}>
            <legend>Folder</legend>
            {folders.map((f) => (
              <label key={f.id} className={`folder-opt ${target === f.id ? 'on' : ''}`}>
                <input type="radio" name="folder" checked={target === f.id} onChange={() => setTarget(f.id)} />
                <span className="folder-name">{f.title}</span>
                <span className="muted">
                  {f.page_count} page{f.page_count === 1 ? '' : 's'}
                </span>
              </label>
            ))}
            <label className={`folder-opt ${target === NEW ? 'on' : ''}`}>
              <input type="radio" name="folder" checked={target === NEW} onChange={() => setTarget(NEW)} />
              <span className="folder-name">New folder…</span>
            </label>
            {target === NEW && (
              <input
                className="text-input"
                placeholder="Folder name, e.g. the book's title"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={120}
                autoFocus
              />
            )}
          </fieldset>
        )}

        <p className="muted hint">
          Photos are added in the order you pick them. Lay each page flat, in good light, filling the frame.
        </p>

        <div className="sheet-actions">
          <button className="btn primary" disabled={busy || needsName} onClick={() => camera.current?.click()}>
            Take photo
          </button>
          <button className="btn" disabled={busy || needsName} onClick={() => gallery.current?.click()}>
            Choose photos
          </button>
        </div>
        <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={(e) => upload(e.target.files)} />
        <input ref={gallery} type="file" hidden multiple accept="image/*" onChange={(e) => upload(e.target.files)} />

        {progress && <p className="notice">{progress}</p>}
        {done && <p className="notice">{done}</p>}
        {errors.map((m, i) => (
          <p key={i} className="notice error">
            {m}
          </p>
        ))}

        <button className="btn sheet-close" onClick={onClose} disabled={busy}>
          Done
        </button>
      </div>
    </div>
  )
}
