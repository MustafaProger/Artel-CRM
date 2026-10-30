import { useRef, useState } from 'react'
import { ArrowUpRight, ClipboardList, LoaderCircle, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { Company, Directories } from './model'
import { compareRequestDates, requestDateLabel } from './trip-request-schedule'
import type { TripRequest } from './trip-request-model'
import { getDeliveryPlaceDisplay } from './trip-request-display'
import TripRequestEditor from './TripRequestEditor'
import { apiFetch as fetch } from './workspace-api'
import { mapLink } from './map-link'
import { tripRequestMapCoordinates } from './trip-request-map-coordinates'
import { useDialogMotion } from './useDialogMotion'
import { number } from './utils'
import './trip-requests.css'

export default function TripRequestsPanel({ requests, loading, error, companies, directories, onReload, onSaved, onDeleted }: {
  requests: TripRequest[]; loading: boolean; error: string; companies: Company[]; directories: Directories; onReload: () => void; onSaved: (request: TripRequest) => void; onDeleted: (id: string) => void
}) {
  const [query, setQuery] = useState(''), [editor, setEditor] = useState<{ request?: TripRequest } | null>(null), [deleting, setDeleting] = useState<TripRequest | null>(null)
  const [notice, setNotice] = useState('')
  const visible = requests.filter(request => [request.companyName, request.addressName, request.address, request.comment].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))).sort(compareRequestDates)
  return <section className="trip-requests-panel" aria-label="Заявки на доставку">
    <div className="trips-toolbar search-add-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск заявки" placeholder="Компания, адрес, комментарий…" value={query} onChange={event => setQuery(event.target.value)}/></label><button type="button" className="button primary mobile-icon-action" aria-label="Новая заявка" title="Новая заявка" onClick={() => setEditor({})}><Plus size={17}/><span className="mobile-action-label">Новая заявка</span></button></div>
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={onReload}>Повторить загрузку</button></div>}
    {loading ? <div className="shipment-trip-loading" role="status"><LoaderCircle className="spin" size={22}/>Загружаем заявки…</div> : <>
      {!!visible.length && <div className="trip-request-summary"><span>Заявок: {visible.length}</span><strong>{number(visible.reduce((sum, request) => sum + Number(request.quantityLitres), 0))} л</strong></div>}
      <div className="trip-requests-list">{visible.map(request => {
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
          <footer>{link && <a href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight size={14}/></a>}<div className="trip-request-actions"><button type="button" className="button trip-request-edit" aria-label={`Изменить заявку: ${request.companyName}, ${request.addressName}`} onClick={() => setEditor({ request })}><Pencil size={16}/><span>Изменить</span></button><button type="button" className="button trip-request-delete" aria-label={`Удалить заявку: ${request.companyName}, ${request.addressName}`} onClick={() => setDeleting(request)}><Trash2 size={16}/><span>Удалить</span></button></div></footer>
        </article>
      })}</div>
      {!visible.length && !error && <div className="panel trips-empty"><ClipboardList size={30}/><h2>{query ? 'Заявки не найдены' : 'Заявок пока нет'}</h2><p>{query ? 'Измените поисковый запрос.' : 'Создайте заявку, чтобы выбрать её при заполнении рейса.'}</p>{!query && <button type="button" className="button primary" onClick={() => setEditor({})}><Plus size={17}/>Создать заявку</button>}</div>}
    </>}
    {editor && <TripRequestEditor request={editor.request} companies={companies} directories={directories} onClose={() => { setEditor(null); onReload() }} onSaved={saved => { setEditor(null); setNotice(editor.request ? 'Заявка обновлена.' : 'Заявка создана. Её можно добавить в рейс.'); onSaved(saved) }}/>}
    {deleting && <DeleteRequestDialog request={deleting} onClose={() => { setDeleting(null); onReload() }} onDeleted={() => { const id = deleting.id; setDeleting(null); setNotice('Заявка удалена.'); onDeleted(id) }}/>}
  </section>
}

function DeleteRequestDialog({ request, onClose: onDismiss, onDeleted }: { request: TripRequest; onClose: () => void; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), busy = useRef(false)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const { close, complete } = useDialogMotion(dialog, onDismiss)
  const remove = async () => {
    if (busy.current) return
    busy.current = true; setSaving(true); setError('')
    try {
      const response = await fetch(`/api/trip-requests/${encodeURIComponent(request.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: request.version }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось удалить заявку.')
      await complete(onDeleted)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось получить ответ сервера.') }
    finally { busy.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="shipment-delete-dialog" aria-labelledby="request-delete-title" onCancel={event => { event.preventDefault(); if (!busy.current) close() }}><h2 id="request-delete-title">Удалить заявку?</h2><p><strong>{request.companyName}</strong><br/>{request.address}<br/>{number(request.quantityLitres)} л</p><p>Заявка исчезнет из списка доступных доставок и с карты.</p>{error && <p className="shipment-error" role="alert">{error}</p>}<footer><button type="button" className="button" autoFocus disabled={saving} onClick={close}>Отмена</button><button type="button" className="button danger" disabled={saving} onClick={() => void remove()}>{saving ? <LoaderCircle className="spin" size={17}/> : <Trash2 size={17}/>}Удалить заявку</button></footer></dialog>
}
