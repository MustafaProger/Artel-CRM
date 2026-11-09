import { useViewEntrance } from './useViewEntrance'
import LoadingSkeleton, { LoadingProgress, SkeletonBar } from './LoadingSkeleton'
import { useEffect, useState } from 'react'
import { ChevronRight, Folder, Plus, Trash2 } from 'lucide-react'
import ScrollableSegments from './ScrollableSegments'
import DocumentEditor from './DocumentEditor'
import DocumentDeleteDialog from './DocumentDeleteDialog'
import { documentsRequest } from './documents-api'
import { documentExpired, moscowToday, type ArchiveItem, type DocumentArchiveView } from './documents-model'
import './documents.css'
export default function DocumentsPage() {
  const [deletingCategory, setDeletingCategory] = useState(false)
  const [archive, setArchive] = useState<DocumentArchiveView>({ categories: [], items: [], documents: [] })
  const [categoryId, setCategoryId] = useState(''), [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ kind: 'category' | 'card'; item?: ArchiveItem } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [today, setToday] = useState(moscowToday)
  const category = archive.categories.find(c => c.id === categoryId) ?? archive.categories[0]
  const viewEntrance = useViewEntrance<HTMLElement>(category?.id ?? '', '.archive-item, .archive-empty', 6)
  const reload = async () => { setLoading(true); try { setArchive(await documentsRequest<DocumentArchiveView>('')); setLoaded(true); setError('') } catch (e) { setError((e as Error).message) } finally { setLoading(false) } }
  useEffect(() => { void reload(); const timer = setInterval(() => setToday(moscowToday()), 30000); return () => clearInterval(timer) }, [])
  const open = (next: NonNullable<typeof editor>, button: HTMLButtonElement) => { button.focus({ preventScroll: true }); setEditor(next); setNotice('') }
  const items = archive.items.filter(i => i.categoryId === category?.id && i.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
  return <section ref={viewEntrance} className="document-archive" aria-label="Архив документов">
    {loading && !loaded && <div className="archive-category-tabs loading-skeleton__categories" aria-hidden="true"><SkeletonBar size="field"/><SkeletonBar size="field"/></div>}
    {!!archive.categories.length && <ScrollableSegments className="directory-tabs archive-category-tabs" label="Категории документов" value={category?.id ?? ''}>{archive.categories.map(c => <button className={`button ${c.id === category?.id ? 'primary' : ''}`} aria-pressed={c.id === category?.id} key={c.id} onClick={() => { setCategoryId(c.id); setQuery(''); setNotice(''); setError('') }}>{c.name}</button>)}</ScrollableSegments>}
    <div className="archive-controls">
      <label className="archive-search">Поиск<input type="search" placeholder="Наименование документа" value={query} disabled={!category} onChange={e => setQuery(e.target.value)}/></label>
      <div className="archive-actions archive-main-actions"><button className="button archive-remove" disabled={loading || !category} onClick={event => { event.currentTarget.focus(); setDeletingCategory(true) }} aria-label="Удалить категорию" title="Удалить категорию"><Trash2 size={18}/></button><button className="button" disabled={loading} onClick={event => open({ kind: 'category' }, event.currentTarget)}><Plus size={18}/>Добавить категорию</button><button className="button primary" disabled={loading || !category} onClick={event => open({ kind: 'card' }, event.currentTarget)}><Plus size={18}/>Добавить документ</button></div>
    </div>
    {error && <div className="archive-error" role="alert">{error} <button className="button" disabled={loading} onClick={() => void reload()}>Повторить загрузку</button></div>}{notice && <p className="archive-notice" role="status">{notice}</p>}
    {loading && loaded && <LoadingProgress label="Обновляем документы"/>}
    {!loaded ? loading ? <LoadingSkeleton variant="documents" label="Загружаем документы" rows={5}/> : null : !category ? <div className="archive-empty"><Folder size={32}/><h2>Создайте первую категорию</h2></div> : <div className="archive-list view-entrance">{items.length ? items.map(i => {
      const files = archive.documents.filter(d => d.itemId === i.id), expired = files.filter(d => documentExpired(d.expiresOn, today)).length
      return <button className="archive-item" key={i.id} aria-haspopup="dialog" onClick={event => open({ kind: 'card', item: i }, event.currentTarget)}><Folder size={23} aria-hidden="true"/><span className="archive-item-info"><strong>{i.name}</strong><span>Файлов: {files.length}{expired > 0 && <span className="archive-item-expired"> · Просрочено: {expired}</span>}</span></span><ChevronRight size={20} aria-hidden="true"/></button>
    }) : <div className="archive-empty"><Folder size={32}/><h2>{query ? 'Ничего не найдено' : 'Документов пока нет'}</h2><p>{query ? 'Измените поисковый запрос.' : 'Нажмите «Добавить документ», укажите наименование и прикрепите файлы.'}</p></div>}</div>}
    {deletingCategory && category && <DocumentDeleteDialog kind="categories" id={category.id} name={category.name} onClose={() => setDeletingCategory(false)} onDeleted={next => { setArchive(next); setLoaded(true); setError(''); setCategoryId(next.categories[0]?.id ?? ''); setQuery(''); setDeletingCategory(false); setNotice('Категория и все её документы удалены') }}/ >}
    {editor && <DocumentEditor kind={editor.kind} category={category} item={editor.item} files={archive.documents.filter(d => d.itemId === editor.item?.id)} onClose={() => setEditor(null)} onDeleted={next => { setArchive(next); setLoaded(true); setError(''); setEditor(null); setNotice('Документ удалён') }} onSaved={(next, id) => { setArchive(next); setLoaded(true); setError(''); setCategoryId(id); setQuery(''); setEditor(null); setNotice('Сохранено') }}/ >}
  </section>
}
