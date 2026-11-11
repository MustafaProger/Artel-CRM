import { useDirectAction } from './useDirectAction'
import LoadingSkeleton, { LoadingProgress } from './LoadingSkeleton'
import { useState } from 'react'
import { ArrowUpRight, ClipboardList, LoaderCircle, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { Company, Directories } from './model'
import { compareRequestDates, requestDateLabel } from './trip-request-schedule'
import type { TripRequest } from './trip-request-model'
import { getDeliveryPlaceDisplay } from './trip-request-display'
import TripRequestEditor from './TripRequestEditor'
import { apiFetch as fetch } from './workspace-api'
import { mapLink } from './map-link'
import { tripRequestMapCoordinates } from './trip-request-map-coordinates'
import { creationTime, number } from './utils'
import './trip-requests.css'

export default function TripRequestsPanel({ requests, loading, loaded = requests.length > 0, error, companies, directories, onReload, onSaved, onDeleted }: {
  requests: TripRequest[]; loading: boolean; loaded?: boolean; error: string; companies: Company[]; directories: Directories; onReload: () => void; onSaved: (request: TripRequest) => void; onDeleted: (id: string) => void
}) {
  const [query, setQuery] = useState(''), [editor, setEditor] = useState<{ request?: TripRequest } | null>(null)
  const [notice, setNotice] = useState('')
  const removal = useDirectAction()
  const remove = (request: TripRequest) => removal.run(request.id, async () => {
    const response = await fetch(`/api/trip-requests/${encodeURIComponent(request.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: request.version }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Не удалось удалить заявку.')
    onDeleted(request.id)
    setNotice('Заявка удалена.')
  })
  const visible = requests.filter(request => [request.companyName, request.addressName, request.address, request.comment].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))).sort(compareRequestDates)
  return <section className="trip-requests-panel" aria-label="Заявки на доставку">
    <div className="trips-toolbar search-add-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск заявки" placeholder="Компания, адрес, комментарий…" value={query} onChange={event => setQuery(event.target.value)}/></label><button type="button" className="button primary mobile-icon-action" aria-label="Новая заявка" title="Новая заявка" onClick={() => setEditor({})}><Plus size={17}/><span className="mobile-action-label">Новая заявка</span></button></div>
    {removal.error && <p className="shipment-error" role="alert">{removal.error}</p>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={onReload}>Повторить загрузку</button></div>}
    {loading && loaded && <LoadingProgress label="Обновляем заявки"/>}
    {loading && !loaded ? <LoadingSkeleton variant="requests" label="Загружаем заявки" rows={4}/> : <>
      {!!visible.length && <div className="trip-request-summary"><span>Заявок: {visible.length}</span><strong>{number(visible.reduce((sum, request) => sum + Number(request.quantityLitres), 0))} л</strong></div>}
      <div className="trip-requests-list view-entrance">{visible.map(request => {
        const place = getDeliveryPlaceDisplay(request.addressName, request.address)
        const point = tripRequestMapCoordinates(request, directories.addresses)
        const link = mapLink({ ...request, ...(point?.status === 'found' ? point : {}) })
        return <article className="panel trip-request-card" key={request.id} data-testid="trip-request-card">
          <header><div><h2>{request.companyName}</h2></div><strong className="trip-request-litres">{number(request.quantityLitres)} л</strong></header>
          <p className="trip-request-price"><span>Цена для клиента</span>{request.salePricePerLitre ? <strong>{number(request.salePricePerLitre, 6)} ₽/л</strong> : <span>Цена не указана</span>}</p>
          <dl className="trip-request-location">
            <div><dt>Дата выполнения</dt><dd>{requestDateLabel(request.executionDate)}</dd></div>
            {place.name && <div><dt>Площадка</dt><dd>{place.name}</dd></div>}
            <div><dt>Адрес доставки</dt><dd>{place.address}</dd></div>
          </dl>
          {request.comment.trim() && <section className="trip-request-comment" aria-label="Комментарий"><h3>Комментарий</h3><p>{request.comment}</p></section>}
          <small className="trip-creation-meta">Создана: {request.createdByName ?? 'автор неизвестен'} · <time dateTime={request.createdAt}>{creationTime(request.createdAt)}</time></small>
          <footer>{link && <a href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight size={14}/></a>}<div className="trip-request-actions"><button type="button" className="button trip-request-edit" aria-label={`Изменить заявку: ${request.companyName}, ${request.addressName}`} onClick={() => setEditor({ request })}><Pencil size={16}/><span>Изменить</span></button><button type="button" className="button trip-request-delete" aria-label={`Удалить заявку: ${request.companyName}, ${request.addressName}`} disabled={!!removal.pending} onClick={() => void remove(request)}>{removal.pending === request.id ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}<span>Удалить</span></button></div></footer>
        </article>
      })}</div>
      {!visible.length && !error && <div className="panel trips-empty trip-requests-empty"><ClipboardList size={30}/><h2>{query ? 'Заявки не найдены' : 'Заявок пока нет'}</h2>{query && <p>Измените поисковый запрос.</p>}{!query && <button type="button" className="button primary" onClick={() => setEditor({})}><Plus size={17}/>Создать заявку</button>}</div>}
    </>}
    {editor && <TripRequestEditor request={editor.request} companies={companies} directories={directories} onClose={() => { setEditor(null); onReload() }} onSaved={saved => { setEditor(null); setNotice(editor.request ? 'Заявка обновлена.' : 'Заявка создана. Её можно добавить в рейс.'); onSaved(saved) }}/>}
  </section>
}
