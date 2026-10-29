import { useId, useRef, useState } from 'react'
import { useDialogMotion } from './useDialogMotion'
import { documentsRequest } from './documents-api'
import type { DocumentArchiveView } from './documents-model'

export default function DocumentDeleteDialog({ kind, id, name, version, onClose, onDeleted }: {
  kind: 'categories' | 'cards'; id: string; name: string; version?: number;
  onClose: () => void; onDeleted: (archive: DocumentArchiveView) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId(), lock = useRef(false)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const remove = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await documentsRequest<{ archive: DocumentArchiveView }>(`/${kind}/${id}`, { version: version ?? 1 }, 'DELETE')
      await complete(() => onDeleted(result.archive))
    } catch (e) { setError((e as Error).message) } finally { lock.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="archive-delete-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!lock.current) close() }}>
    <h2 id={titleId}>{kind === 'categories' ? 'Удалить категорию?' : 'Удалить документ?'}</h2>
    <p id={descriptionId}>{kind === 'categories' ? `Категория «${name}», все её документы и прикреплённые файлы будут удалены.` : `Документ «${name}» и все его прикреплённые файлы будут удалены.`} Отменить удаление нельзя.</p>
    {error && <p className="archive-error" role="alert">{error}</p>}
    <div className="archive-actions"><button autoFocus className="button" disabled={busy} onClick={close}>Отмена</button><button className="button archive-danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Удаляем…' : 'Удалить'}</button></div>
  </dialog>
}
