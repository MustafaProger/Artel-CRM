import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Download, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react'
import { useDialogMotion } from './useDialogMotion'
import { documentsRequest } from './documents-api'
import { documentExpired, documentMaxBytes, type ArchiveItem, type DocumentArchiveView, type DocumentCategory } from './documents-model'

type DraftFile = { key: string; id?: string; title: string; expiresOn: string; fileName: string; file?: File; removed?: boolean }
export default function DocumentEditor({ kind, category, item, files, onClose, onSaved }: {
  kind: 'category' | 'card'; category?: DocumentCategory; item?: ArchiveItem; files: DocumentArchiveView['documents']; onClose: () => void;
  onSaved: (archive: DocumentArchiveView, categoryId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), lock = useRef(false), backdropDown = useRef(false)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const [name, setName] = useState(item?.name ?? '')
  const [rows, setRows] = useState<DraftFile[]>(() => files.map(f => ({ key: f.id, id: f.id, title: f.title, expiresOn: f.expiresOn ?? '', fileName: f.fileName })))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleFile = (key: string) => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const initial = useRef(JSON.stringify({ name: item?.name ?? '', rows }))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [discard, setDiscard] = useState(false)
  const dirty = initial.current !== JSON.stringify({ name, rows })
  const dismiss = () => { if (lock.current) return; if (dirty) setDiscard(true); else close() }
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  const update = (key: string, change: Partial<DraftFile>) => setRows(current => current.map(row => row.key === key ? { ...row, ...change } : row))
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(node => node.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const outside = (event: { clientX: number; clientY: number }) => { const b = dialog.current!.getBoundingClientRect(); return event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setDiscard(false)
    try {
      const attachments = kind === 'category' ? [] : await Promise.all(rows.filter(row => !row.removed).map(async row => {
        if (row.file && (!row.file.size || row.file.size > documentMaxBytes)) throw new Error(`«${row.title || row.file.name}»: выберите непустой файл до 5 МБ.`)
        if (!row.id && !row.file) throw new Error('Прикрепите файл к каждому добавленному документу.')
        const encoded = row.file ? await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(row.file!) }) : undefined
        return { id: row.id, title: row.title, expiresOn: row.expiresOn || null, ...(row.file ? { fileName: row.file.name, data: encoded } : {}) }
      }))
      const result = await documentsRequest<{ archive: DocumentArchiveView; entry: { id: string; categoryId?: string } }>(kind === 'category' ? '/categories' : `/cards${item ? `/${item.id}` : ''}`, kind === 'category' ? { name } : { name, categoryId: category?.id, version: item?.version ?? 1, files: attachments }, item ? 'PATCH' : 'POST')
      await complete(() => onSaved(result.archive, kind === 'category' ? result.entry.id : category!.id))
    } catch (e) { setError((e as Error).message) } finally { lock.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="archive-drawer" aria-labelledby={titleId} onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); dismiss() }} onPointerDown={event => { backdropDown.current = event.target === event.currentTarget && outside(event) }} onClick={event => { if (backdropDown.current && event.target === event.currentTarget && outside(event)) dismiss(); backdropDown.current = false }}>
    <header className="archive-drawer-heading"><h2 id={titleId}>{kind === 'category' ? 'Новая категория' : item?.name ?? 'Новый документ'}</h2><button type="button" className="icon-button" aria-label="Закрыть окно" disabled={busy} onClick={dismiss}><X size={20}/></button></header>
    <form onSubmit={save} className="archive-drawer-form">
      <div className="archive-drawer-body">
        {kind === 'card' && <p className="archive-category-name">{category?.name}</p>}
        <label>{kind === 'category' ? 'Название категории' : 'Наименование'}<input autoFocus required maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={kind === 'category' ? 'Например, Водители' : 'Например, Гена'}/></label>
        {kind === 'card' && <><div className="archive-files-heading"><h3>Документы</h3><button className="button" type="button" disabled={busy} onClick={() => setRows(current => [...current, { key: crypto.randomUUID(), title: '', expiresOn: '', fileName: '' }])}><Plus size={18}/>Добавить файл</button></div>
          {!rows.length && <p className="archive-hint">Прикрепите паспорт, СНИЛС или другие документы. Для каждого можно указать название и срок.</p>}
          <div className="archive-file-list">{rows.map((row, index) => row.removed ? <div className="archive-file-removed" key={row.key}><span>Будет удалён: {row.title || 'Новый файл'}</span><button className="button" type="button" disabled={busy} onClick={() => update(row.key, { removed: false })}><Undo2 size={16}/>Вернуть</button></div> : row.id && !expanded.has(row.key) ? <div className={`archive-file-row${documentExpired(row.expiresOn || null) ? ' is-expired' : ''}`} key={row.key}>
            <div className="archive-file-summary"><strong>{row.title}</strong>{documentExpired(row.expiresOn || null) && <span>Срок истёк · {row.expiresOn!.split('-').reverse().join('.')}</span>}</div>
            <button className="icon-button archive-file-edit" type="button" disabled={busy} aria-label={`Изменить ${row.title}`} aria-expanded={false} onClick={() => toggleFile(row.key)}><Pencil size={18}/></button>
            <a className="icon-button archive-file-download" href={`/api/documents/entries/${row.id}/file`} download={row.fileName} aria-label={`Скачать ${row.title}`} title="Скачать"><Download size={18}/></a>
          </div> : <fieldset className={`archive-file-editor${documentExpired(row.expiresOn || null) ? ' is-expired' : ''}`} key={row.key} disabled={busy}>
            <legend>Документ {index + 1}</legend>
            <div className="archive-file-title"><label>Название документа<input aria-label={`Название документа ${index + 1}`} required maxLength={200} value={row.title} placeholder="Например, паспорт" onChange={event => update(row.key, { title: event.target.value })}/></label><button className="icon-button archive-remove" type="button" aria-label={`Удалить документ ${index + 1}`} onClick={() => update(row.key, { removed: true })}><Trash2 size={18}/></button></div>
            {row.id && <a className="archive-download" href={`/api/documents/entries/${row.id}/file`} download={row.fileName}><Download size={16}/>{row.fileName}</a>}
            <label>{row.id ? 'Заменить файл' : 'Файл'}<input aria-label={`Файл ${index + 1}`} type="file" required={!row.id} onChange={event => update(row.key, { file: event.target.files?.[0] })}/><small>До 5 МБ{row.file ? ` · Выбран: ${row.file.name}` : ''}</small></label>
            <label>Действует до<input aria-label={`Действует до ${index + 1}`} type="date" value={row.expiresOn} onChange={event => update(row.key, { expiresOn: event.target.value })}/><small>{documentExpired(row.expiresOn || null) ? 'Срок истёк' : 'Необязательно. Без даты — без срока.'}</small></label>
            {row.id && <button className="button archive-file-done" type="button" onClick={() => { if (!row.title.trim()) { setError('Укажите название документа.'); return }; toggleFile(row.key) }}>Готово</button>}
          </fieldset>)}</div>
        </>}
      </div>
      <footer className="archive-drawer-footer">
        {error && <p className="archive-error" role="alert">{error}</p>}
        {discard ? <div className="archive-discard" role="alert"><p>Есть несохранённые изменения.</p><div className="archive-actions"><button className="button" type="button" onClick={() => setDiscard(false)}>Продолжить редактирование</button><button className="button" type="button" onClick={close}>Не сохранять</button></div></div> : <div className="archive-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button><button className="button" type="button" disabled={busy} onClick={dismiss}>Отмена</button></div>}
      </footer>
    </form>
  </dialog>
}
