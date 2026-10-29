import { useEffect, useState } from 'react'
import { ChevronRight, Folder, Plus, RefreshCw } from 'lucide-react'
import ScrollableSegments from './ScrollableSegments'
import DocumentEditor from './DocumentEditor'
import { documentsRequest } from './documents-api'
import { documentExpired, moscowToday, type ArchiveItem, type DocumentArchiveView } from './documents-model'
import './documents.css'
export default function DocumentsPage() {
  const [archive, setArchive] = useState<DocumentArchiveView>({ categories: [], items: [], documents: [] })
  const [categoryId, setCategoryId] = useState(''), [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ kind: 'category' | 'card'; item?: ArchiveItem } | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [today, setToday] = useState(moscowToday)
  const category = archive.categories.find(c => c.id === categoryId) ?? archive.categories[0]
  const reload = async () => { setLoading(true); try { setArchive(await documentsRequest<DocumentArchiveView>('')); setError('') } catch (e) { setError((e as Error).message) } finally { setLoading(false) } }
  useEffect(() => { void reload(); const timer = setInterval(() => setToday(moscowToday()), 30000); return () => clearInterval(timer) }, [])
  const open = (next: NonNullable<typeof editor>, button: HTMLButtonElement) => { button.focus({ preventScroll: true }); setEditor(next); setNotice('') }
  const items = archive.items.filter(i => i.categoryId === category?.id && i.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
  return <section className="document-archive" aria-label="Архив документов">
    {!!archive.categories.length && <ScrollableSegments className="directory-tabs archive-category-tabs" label="Категории документов" value={category?.id ?? ''}>{archive.categories.map(c => <button className={`button ${c.id === category?.id ? 'primary' : ''}`} aria-pressed={c.id === category?.id} key={c.id} onClick={() => { setCategoryId(c.id); setQuery(''); setNotice(''); setError('') }}>{c.name}</button>)}</ScrollableSegments>}
    <div className="archive-controls">
      <label className="archive-search">Поиск<input type="search" placeholder="Наименование документа" value={query} disabled={!category} onChange={e => setQuery(e.target.value)}/></label>
      <div className="archive-actions archive-main-actions"><button className="button" disabled={loading} onClick={() => void reload()} aria-label="Обновить документы" title="Обновить"><RefreshCw size={18}/></button><button className="button" disabled={loading} onClick={event => open({ kind: 'category' }, event.currentTarget)}><Plus size={18}/>Добавить категорию</button><button className="button primary" disabled={loading || !category} onClick={event => open({ kind: 'card' }, event.currentTarget)}><Plus size={18}/>Добавить документ</button></div>
    </div>
    {error && <p className="archive-error" role="alert">{error}</p>}{notice && <p className="archive-notice" role="status">{notice}</p>}
    {loading ? <p role="status">Загружаем документы…</p> : !category ? <div className="archive-empty"><Folder size={32}/><h2>Создайте первую категорию</h2></div> : <div className="archive-list">{items.length ? items.map(i => {
      const files = archive.documents.filter(d => d.itemId === i.id), expired = files.filter(d => documentExpired(d.expiresOn, today)).length
      return <button className="archive-item" key={i.id} aria-haspopup="dialog" onClick={event => open({ kind: 'card', item: i }, event.currentTarget)}><Folder size={23} aria-hidden="true"/><span className="archive-item-info"><strong>{i.name}</strong><span>Файлов: {files.length}{expired > 0 && <span className="archive-item-expired"> · Просрочено: {expired}</span>}</span></span><ChevronRight size={20} aria-hidden="true"/></button>
    }) : <div className="archive-empty"><Folder size={32}/><h2>{query ? 'Ничего не найдено' : 'Документов пока нет'}</h2><p>{query ? 'Измените поисковый запрос.' : 'Нажмите «Добавить документ», укажите наименование и прикрепите файлы.'}</p></div>}</div>}
    {editor && <DocumentEditor kind={editor.kind} category={category} item={editor.item} files={archive.documents.filter(d => d.itemId === editor.item?.id)} onClose={() => setEditor(null)} onSaved={(next, id) => { setArchive(next); setCategoryId(id); setQuery(''); setEditor(null); setNotice('Сохранено') }}/ >}
  </section>
}
