import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Download, FileCheck2, LoaderCircle, RefreshCw, Save, Send } from 'lucide-react'
import type { ShipmentTrip, Snapshot } from './model'
import type { EtrnDeliverySummary, EtrnDocumentSummary, EtrnTripResponse } from './etrn-api-model'
import type { SabyConsignmentProfile } from './etrn-model'
import type { SabyDocumentSummary, SabyTripResponse } from './saby-model'
import EtrnProfileForm, { emptyEtrnProfile } from './EtrnProfileForm'

const documentStatus: Record<EtrnDocumentSummary['status'], string> = {
  pending: 'Передача выполняется', unknown: 'Результат требует сверки', draft: 'Создано в Saby', error: 'Ошибка передачи',
}
const signatureStatus: Record<EtrnDocumentSummary['signatureStatus'], string> = {
  not_signed: 'Подпись не получена', reported_by_saby: 'Saby сообщает о наличии подписи', unknown: 'Наличие подписи не подтверждено',
}
function safeSabyUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && ['saby.ru', 'sbis.ru'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null
  } catch { return null }
}
function safeFileUrl(value: string, endpoint: string, shipmentId: string): string | null {
  const prefix = `${endpoint}/files/${encodeURIComponent(shipmentId)}/`
  return value.startsWith(prefix) && !value.slice(prefix.length).includes('/') && !/[?#\\]/.test(value) ? value : null
}
function updatedAt(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'Неизвестно'
}

type Action = 'save' | 'submit' | 'refresh'
interface DeliveryProps {
  delivery: EtrnDeliverySummary
  title: string
  configured: boolean
  busy: boolean
  endpoint: string
  perform: (action: Action, shipmentId: string, profile?: SabyConsignmentProfile) => Promise<void>
}

function EtrnDelivery({ delivery, title, configured, busy, endpoint, perform }: DeliveryProps) {
  const saved = JSON.stringify(delivery.profile ?? emptyEtrnProfile())
  const [profile, setProfile] = useState<SabyConsignmentProfile>(() => delivery.profile ?? emptyEtrnProfile())
  useEffect(() => { setProfile(JSON.parse(saved)) }, [saved])
  const dirty = JSON.stringify(profile) !== saved
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const document = delivery.document
  const locked = !!document && (document.status !== 'error' || !!document.id)
  const uncertain = document?.status === 'pending' || document?.status === 'unknown'
  const validated = !dirty && !delivery.blockers.length && profile.confirmed
  const ready = configured && validated
  const sabyUrl = safeSabyUrl(document?.url)
  const [showFacts, setShowFacts] = useState(!document)
  return <section className="etrn-delivery" aria-label={`ЭТрН · ${title}`} data-testid="etrn-delivery">
    <header className="etrn-delivery-heading"><div><h3>{title}</h3><p role="status">{document ? documentStatus[document.status] : dirty ? 'Есть несохранённые изменения' : ready ? 'Данные проверены · можно создать ЭТрН' : 'Подготовка данных ЭТрН'}</p></div>
      <button type="button" className="button" disabled={busy || dirty || !document} onClick={() => void perform('refresh', delivery.shipmentId)}><RefreshCw size={15}/>{uncertain ? 'Сверить с Saby' : 'Обновить из Saby'}</button>
    </header>
    {document && <div className="etrn-result">
      <dl className="etrn-evidence">
        <div><dt>Состояние в Saby</dt><dd>{document.remoteStatus || 'Ответ о состоянии не получен'}</dd></div>
        <div><dt>Подпись</dt><dd>{signatureStatus[document.signatureStatus]}</dd></div>
        <div><dt>ГИС ЭПД</dt><dd>{document.gisStatus || 'Подтверждение не получено'}</dd></div>
        <div><dt>Последняя сверка · Москва</dt><dd>{updatedAt(document.updatedAt)}</dd></div>
      </dl>
      {document.id && <details className="etrn-identifiers"><summary>Идентификаторы документа</summary><p>ID: {document.id}</p><p>Редакция: {document.revision || 'Не получена'}</p></details>}
      {document.lastError && <p className="shipment-error" role="alert">{document.lastError}</p>}
      {uncertain && <p className="etrn-note">Сначала сверьте результат с Saby. Повторное создание недоступно, пока прежний запрос не проверен.</p>}
      {sabyUrl && <div className="etrn-signing"><a className="button primary" target="_blank" rel="noreferrer" href={sabyUrl}><FileCheck2 size={16}/>Открыть для подписания в Saby <ArrowUpRight size={15}/></a><p>Уполномоченный подписант проверяет документ и подписывает его доступной электронной подписью в Saby. После действия вернитесь сюда и обновите состояние.</p></div>}
      {!!document.availableActions.length && <p className="etrn-note">Доступные действия в Saby: {document.availableActions.join(', ')}.</p>}
      {!!document.files.length && <div className="etrn-files"><strong>Файлы, полученные из Saby</strong><ul>{document.files.map(file => {
        const href = safeFileUrl(file.url, endpoint, delivery.shipmentId)
        return <li key={file.id}>{href ? <a href={href} download><Download size={15}/>{file.name || `Файл ${file.extension}`}</a> : <span>{file.name}</span>}{file.size !== undefined && <small>{Math.ceil(file.size / 1024)} КБ</small>}</li>
      })}</ul></div>}
    </div>}
    <button type="button" className="trip-text-button" aria-expanded={showFacts} onClick={() => setShowFacts(current => !current)}>{showFacts ? 'Скрыть данные ЭТрН' : 'Посмотреть данные ЭТрН'}</button>
    {showFacts && <>
      <p className="etrn-note">Дата, маршрут, объём, водитель и номер автомобиля берутся из сохранённого рейса. Ниже — сведения для ЭТрН этой доставки. Погрузка указывается по факту.</p>
      <EtrnProfileForm value={profile} disabled={busy || locked} onChange={setProfile}/>
    </>}
    {!locked && <div className="etrn-actions"><button type="button" className="button" disabled={busy} onClick={() => void perform('save', delivery.shipmentId, profile)}><Save size={16}/>Сохранить и проверить</button>{dirty && <span className="etrn-note" role="status">Сохраните изменения перед формированием документа.</span>}</div>}
    {!!delivery.blockers.length && !locked && <div className="trip-saby-blockers"><p>Для формирования ЭТрН нужно:</p><ul>{delivery.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
    <footer className="etrn-actions">
      {!locked && <button type="button" className="button primary" disabled={busy || !ready} onClick={() => void perform('submit', delivery.shipmentId)}><Send size={16}/>Создать ЭТрН в Saby</button>}
      {validated && <a className="button" href={`${endpoint}/xml/${encodeURIComponent(delivery.shipmentId)}`} download><Download size={15}/>Скачать XML грузоотправителя</a>}
      {locked && <p className="etrn-note">Сохранённые данные отправленного документа доступны для просмотра. Действия следующих участников и регистрация в ГИС подтверждаются отдельно.</p>}
    </footer>
  </section>
}

export default function TripEtrnPanel({ trip, data }: { trip: ShipmentTrip; data: Snapshot }) {
  const endpoint = `/api/shipment-trips/${encodeURIComponent(trip.id)}/etrn`
  const [result, setResult] = useState<EtrnTripResponse | null>(null)
  const [legacy, setLegacy] = useState<SabyDocumentSummary[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const lock = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError(''); setResult(null)
    const read = async () => {
      try {
        const response = await fetch(endpoint, { signal: controller.signal })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Не удалось загрузить ЭТрН')
        setResult(body)
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void read()
    void fetch(`/api/shipment-trips/${encodeURIComponent(trip.id)}/saby`, { signal: controller.signal }).then(async response => {
      if (response.ok) { const body: SabyTripResponse = await response.json(); setLegacy(body.saby.documents) }
    }).catch(() => {})
    return () => controller.abort()
  }, [endpoint, trip.id, reload])
  const perform = async (action: Action, shipmentId: string, profile?: SabyConsignmentProfile) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(action === 'save' ? endpoint : `${endpoint}/${action}`, {
        method: action === 'save' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId, ...(profile ? { profile } : {}) }),
      })
      const body = await response.json()
      if (Array.isArray(body.deliveries)) setResult(body)
      if (!response.ok) throw new Error(body.error || 'Не удалось выполнить действие с ЭТрН')
      setNotice(action === 'save' ? 'Данные сохранены. Результат проверки показан у доставки.' : action === 'refresh' ? 'Сверка завершена. Проверьте результат у доставки.' : 'Запрос обработан. Результат передачи показан у доставки.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером. Обновите состояние перед повтором.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="trip-saby-panel etrn-panel" aria-label="ЭТрН в Saby" aria-busy={busy}>
    <div className="trip-saby-heading"><strong>Электронная транспортная накладная · Saby</strong>{busy && <LoaderCircle size={18} className="spin" aria-label="Выполняется запрос"/>}</div>
    {error && <div className="shipment-error" role="alert">{error}{!result && <button type="button" className="button" disabled={busy} onClick={() => setReload(current => current + 1)}>Повторить загрузку</button>}</div>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {result && !result.configured && <div className="trip-saby-blockers"><p><strong>Подключение не настроено</strong></p><ul>{result.configurationBlockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
    {result?.organizations && <dl className="etrn-evidence">{([['consignor', 'Грузоотправитель'], ['carrier', 'Перевозчик']] as const).map(([key, title]) => {
      const organization = result.organizations![key]
      return <div key={key}><dt>{title}</dt><dd><strong>{organization.name || 'Не настроен'}</strong><p className="etrn-note">ИНН {organization.inn || '—'} · КПП {organization.kpp || '—'}</p><p className="etrn-note">{organization.address}</p></dd></div>
    })}</dl>}
    {result?.deliveries.map((delivery, index) => {
      const customer = trip.customers.find(row => row.id === delivery.shipmentId)
      const company = data.companies.find(row => row.id === customer?.fields.customer_id)
      return <EtrnDelivery key={delivery.shipmentId} delivery={delivery} title={`Доставка ${index + 1} · ${company?.name ?? 'Клиент'}`} configured={result.configured} busy={busy} endpoint={endpoint} perform={perform}/>
    })}
    {!!legacy.length && <details className="etrn-legacy"><summary>Ранее созданные заказы на перевозку</summary><p>Это заказы TransportOrder. Электронная транспортная накладная оформляется отдельно выше.</p><ul>{legacy.map((document, index) => <li key={`${document.shipmentId}-${index}`}>Заказ на перевозку · {document.id || document.status}{safeSabyUrl(document.url) && <a href={safeSabyUrl(document.url)!} target="_blank" rel="noreferrer">Открыть заказ в Saby <ArrowUpRight size={14}/></a>}</li>)}</ul></details>}
  </section>
}
