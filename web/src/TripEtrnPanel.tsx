import { apiFetch as fetch, apiUrl } from './workspace-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Clock3, Copy, Download, FilePlus2, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ShipmentTrip, DirectoryData } from './model'
import type { EtrnTripResponse } from './etrn-api-model'
import type { TripSabyResponse } from './trip-saby-model'
import type { SabyTripResponse } from './saby-model'
import { exchangeStageLabels, workflowTime, workflowView } from './trip-workflow-view'
import './trip-workflow.css'

interface LoadingFacts { arrivedAt: string; departedAt: string; deliveries: Record<string, { grossMassTonnes: string; massMethod: string }> }
type Workflow = TripSabyResponse & { loadingFacts: LoadingFacts | null }
const safeSabyUrl = (value: string | null | undefined) => {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password && ['saby.ru', 'sbis.ru'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null } catch { return null }
}
const steps = ['Подготовка', 'Отправка АРТЕЛЬ', 'Водитель и машина', 'Подтверждение НК', 'Создание ЭТрН', 'Отправка клиентам']

export default function TripEtrnPanel({ trip, data }: { trip: ShipmentTrip; data: DirectoryData }) {
  const endpoint = `/api/shipment-trips/${encodeURIComponent(trip.id)}/saby-workflow`
  const etrnEndpoint = `/api/shipment-trips/${encodeURIComponent(trip.id)}/etrn`
  const [result, setResult] = useState<Workflow | null>(null), [etrn, setEtrn] = useState<EtrnTripResponse | null>(null)
  const [legacy, setLegacy] = useState<SabyTripResponse | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState(''), [copied, setCopied] = useState(false)
  const [facts, setFacts] = useState<LoadingFacts>(() => ({ arrivedAt: '', departedAt: '', deliveries: Object.fromEntries(trip.customers.map(row => [row.id, { grossMassTonnes: '', massMethod: '' }])) }))
  const [confirmed, setConfirmed] = useState(false)
  const lock = useRef(false), mounted = useRef(true), requestGeneration = useRef(0)
  const loadDocuments = useCallback(async (generation: number) => {
    const response = await fetch(etrnEndpoint)
    const body = await response.json()
    if (!mounted.current || generation !== requestGeneration.current) return
    if (!response.ok) throw new Error(body.error || 'Не удалось обновить ЭТрН')
    if (mounted.current) setEtrn(body)
  }, [etrnEndpoint])
  const read = useCallback(async () => {
    const generation = ++requestGeneration.current
    try {
      const response = await fetch(endpoint)
      const body = await response.json()
      if (!mounted.current || generation !== requestGeneration.current) return
      if (!response.ok) throw new Error(body.error || 'Не удалось загрузить состояние Saby')
      setResult(body); setRefreshError('')
      await loadDocuments(generation)
    } catch (reason) {
      if (!mounted.current || generation !== requestGeneration.current) return
      throw reason
    }
  }, [endpoint, loadDocuments])
  useEffect(() => {
    mounted.current = true; setBusy(true)
    void read().catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }).finally(() => { if (mounted.current) setBusy(false) })
    void fetch(`/api/shipment-trips/${encodeURIComponent(trip.id)}/saby`).then(async response => { if (response.ok && mounted.current) setLegacy(await response.json()) }).catch(() => {})
    return () => { mounted.current = false; requestGeneration.current++ }
  }, [read, trip.id])
  const perform = useCallback(async (loadingFacts?: LoadingFacts, carrierDetails = false) => {
    if (lock.current) return
    lock.current = true; const generation = ++requestGeneration.current; setBusy(true); setError('')
    try {
      const response = await fetch(loadingFacts ? `${endpoint}/loading-facts` : carrierDetails ? `${endpoint}/carrier-details` : endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loadingFacts || {}) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Не удалось выполнить обмен с Saby')
      if (mounted.current && generation === requestGeneration.current) setResult(body)
      await loadDocuments(generation)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Ответ не получен. Выполните сверку перед повтором.')
      // A lost POST response may follow a successful save. Read the durable state
      // before presenting the loading form or another start action again.
      await read().catch(() => {})
    }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }, [endpoint, loadDocuments, read])
  // Browser polling only reads durable state. The server owns automatic continuation,
  // so multiple tabs cannot schedule duplicate writes and drafts never start on open.
  useEffect(() => {
    if (!result?.locked) return
    let active = true, refreshing = false
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || lock.current || refreshing) return
      refreshing = true
      try { await read() } catch { if (active) setRefreshError('Нет связи с CRM. Показаны последние полученные сведения; проверим ещё раз через 5 минут.') }
      finally { refreshing = false }
    }
    const timer = window.setInterval(() => { void refresh() }, (result.monitoring?.intervalSeconds || 300) * 1000)
    const onVisible = () => { void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [result?.locked, result?.monitoring?.intervalSeconds, read])
  const title = (shipmentId: string, index: number) => {
    const row = trip.customers.find(customer => customer.id === shipmentId)
    return `Доставка ${index + 1} · ${data.companies.find(company => company.id === row?.fields.customer_id)?.name || 'Клиент'}`
  }
  const orderUrl = safeSabyUrl(result?.order?.url)
  const view = result ? workflowView(result) : null
  const handoff = result?.carrierHandoff
  const copyHandoff = async () => {
    if (!handoff) return
    try {
      await navigator.clipboard.writeText([['Водитель', handoff.driverName], ['Телефон', handoff.driverPhone], ['Госномер', handoff.vehiclePlate], ['Автомобиль', handoff.vehicleType]].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n'))
      setCopied(true)
    } catch { setRefreshError('Не удалось скопировать. Можно выделить данные ниже и скопировать вручную.') }
  }
  const haveLegacy = !result?.locked && (!!legacy?.saby.documents.length || etrn?.deliveries.some(delivery => delivery.document))
  return <section className="trip-saby-panel etrn-panel" aria-label="Документы рейса в Saby" aria-busy={busy}>
    <div className="trip-saby-heading"><div><span className="workflow-eyebrow">ДОКУМЕНТЫ РЕЙСА</span><h3>АРТЕЛЬ → НК АРТЕЛЬ → Клиенты</h3></div>{busy && <LoaderCircle size={18} className="spin" aria-label="Обновление документов"/>}</div>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {result && <>
      <ol className="workflow-steps" aria-label="Этапы обмена">{steps.map((step, index) => <li key={step} className={index < view!.step ? 'is-done' : index === view!.step ? 'is-current' : ''} aria-current={index === view!.step ? 'step' : undefined}><span className="workflow-step-number">{index < view!.step ? <Check size={14}/> : index + 1}</span><span>{step}</span></li>)}</ol>
      <div className="workflow-current" role="status"><strong>{view!.title}</strong><p>{view!.text}</p></div>
      {result.locked && <div className="workflow-monitor"><Clock3 size={16}/><div><strong>{result.monitoring?.enabled ? result.monitoring.intervalSeconds === 15 ? 'Ожидаем готовность Saby · проверка каждые 15 секунд' : 'Проверка Saby каждые 5 минут' : 'Автоматическая проверка не включена'}</strong><span>{result.monitoring?.enabled ? 'Работает и после закрытия страницы.' : result.monitoring?.reason || 'Обновляйте состояние кнопкой ниже.'}</span><span>Последняя проверка Saby: {workflowTime(result.lastCheckedAt)}{result.lastCheckedAt ? ' · Москва' : ''}</span></div></div>}
      {refreshError && <p className="workflow-sync-warning" role="alert">{refreshError}</p>}
      {result.lastError && <p className="shipment-error" role="alert">{result.lastError}</p>}
      {!result.locked && <div className="etrn-actions"><button type="button" className="button primary" disabled={busy || !result.ready} onClick={() => void perform()}><FilePlus2 size={16}/>Создать заявку в Saby</button><button type="button" className="button" disabled={busy} onClick={() => { void read().catch(reason => setError(String(reason))) }}><RefreshCw size={15}/>Проверить готовность</button></div>}
      {!!result.blockers.length && <div className="trip-saby-blockers"><p>Для создания заявки заполните:</p><ul>{result.blockers.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      {result.order && <div className="etrn-result workflow-order"><div><span className="workflow-eyebrow">ОБЩАЯ ЗАЯВКА</span><h4>{result.order.number ? `№ ${result.order.number}` : 'Номер ожидается'}</h4><p>{result.order.remoteStatus || 'Состояние уточняется'}</p>{result.phase === 'completed' && <p className="etrn-note">Последнее состояние перед созданием ЭТрН. Дальше автоматически проверяются ЭТрН доставок.</p>}</div>{orderUrl && <a className="button" href={orderUrl} target="_blank" rel="noreferrer">Открыть заявку в Saby <ArrowUpRight size={14}/></a>}</div>}
      {handoff && !result.carrierConfirmed && <details className="workflow-handoff" open={['carrier_details_required', 'carrier_action_required'].includes(result.order?.exchangeStage ?? '') || undefined}><summary>Данные водителя и автомобиля для НК АРТЕЛЬ</summary><p className="etrn-note">Сведения выбранного водителя и машины заполняются в ответе НК до подписи и утверждения.</p><dl>{[['Водитель', handoff.driverName], ['Телефон', handoff.driverPhone], ['Госномер', handoff.vehiclePlate], ['Автомобиль', handoff.vehicleType]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Не указано'}</dd></div>)}</dl><button className="button" type="button" onClick={() => void copyHandoff()}><Copy size={14}/>{copied ? 'Скопировано' : 'Скопировать данные'}</button></details>}
      {result.locked && !result.carrierConfirmed && <section className="workflow-handoff workflow-carrier-fill" aria-label="Заполнение ответа НК">
        <header><h4>Водитель и машина</h4>{result.carrierFill?.checkedAt && <span className="workflow-fill-checked">Проверено {workflowTime(result.carrierFill.checkedAt)} · Москва</span>}</header>
        {result.carrierFill ? <>
          <ul className="workflow-fill-statuses">{([
            ['Водитель', result.carrierFill.driverSaved],
            ['Автомобиль', result.carrierFill.vehicleSaved],
            ...(result.carrierFill.responsibleSaved === undefined ? [] : [['Ответственный и телефон', result.carrierFill.responsibleSaved]]),
          ] as [string, boolean][]).map(([label, saved]) => <li key={label} className={saved ? 'is-saved' : 'is-pending'}>
            {saved ? <Check size={17} aria-hidden="true"/> : <Clock3 size={17} aria-hidden="true"/>}<div><strong>{label}</strong><span>{saved ? 'Сохранено в Saby' : 'Ожидает подтверждения в Saby'}</span></div>
          </li>)}</ul>
          {!!result.carrierFill.blockers.length && <ul className="workflow-fill-blockers">{result.carrierFill.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
          {result.carrierFill.state === 'saved' && <div className="workflow-fill-next"><Clock3 size={18} aria-hidden="true"/><div><strong>Следующий шаг — подтверждение НК</strong><p>Уполномоченный подписант сможет подтвердить заявку после подключения подписи и МЧД.</p></div></div>}
        </> : <><p className="etrn-note">Заполнить ответ НК сведениями выбранного водителя и автомобиля. CRM дождётся готовности входящей заявки и проверит результат.</p><button type="button" className="button primary" disabled={busy} onClick={() => void perform(undefined, true)}>Заполнить водителя и машину</button></>}
      </section>}
      {result.carrierConfirmed && !result.loadingFacts && <form className="etrn-loading-facts" onSubmit={event => { event.preventDefault(); if (confirmed) void perform(facts) }}>
        <h3>Фактическая погрузка</h3><p className="etrn-note">Заполняется сотрудником по факту. Расчётный тоннаж автоматически сюда не переносится.</p>
        <div className="shipment-field-grid">{([['arrivedAt', 'Прибытие на погрузку · Москва'], ['departedAt', 'Убытие с погрузки · Москва']] as const).map(([key, label]) => <label className="shipment-field" key={key}><span>{label}</span><input type="datetime-local" required disabled={busy} value={facts[key]} onChange={event => setFacts(previous => ({ ...previous, [key]: event.target.value }))}/></label>)}</div>
        {trip.customers.map((row, index) => <fieldset className="shipment-fieldset" key={row.id}><legend>{title(row.id, index)}</legend><div className="shipment-field-grid"><label className="shipment-field"><span>Фактическая масса груза, т</span><input required inputMode="decimal" disabled={busy} value={facts.deliveries[row.id]?.grossMassTonnes || ''} onChange={event => setFacts(previous => ({ ...previous, deliveries: { ...previous.deliveries, [row.id]: { ...previous.deliveries[row.id], grossMassTonnes: event.target.value.replace(',', '.') } } }))}/></label><label className="shipment-field"><span>Способ определения массы</span><select required disabled={busy} value={facts.deliveries[row.id]?.massMethod || ''} onChange={event => setFacts(previous => ({ ...previous, deliveries: { ...previous.deliveries, [row.id]: { ...previous.deliveries[row.id], massMethod: event.target.value } } }))}><option value="">Выберите фактический способ</option><option value="01">Разность массы ТС до и после погрузки</option><option value="02">Поосное взвешивание</option><option value="03">Расчёт по измерениям и документам</option></select></label></div></fieldset>)}
        <label className="trip-invoice-option"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>Подтверждаю фактические сведения погрузки всего рейса</label>
        <button type="submit" className="button primary" disabled={busy || !confirmed}>Сохранить погрузку и продолжить</button>
      </form>}
      {result.loadingFacts && <p className="etrn-note">Факты погрузки сохранены. Исправления документов выполняются в Saby.</p>}
      {result.locked && <button type="button" className="button" disabled={busy} onClick={() => void perform()}><RefreshCw size={15}/>{result.phase === 'unknown' ? 'Сверить результат с Saby' : 'Обновить из Saby'}</button>}
    </>}
    {etrn?.deliveries.filter(delivery => delivery.document).map((delivery, index) => {
      const doc = delivery.document!, url = safeSabyUrl(doc.url)
      return <section className="etrn-delivery" key={delivery.shipmentId}><h3>{title(delivery.shipmentId, index)}</h3><p>{doc.remoteStatus || (doc.status === 'draft' ? 'Черновик ЭТрН создан в АРТЕЛЬ' : doc.status === 'pending' ? 'Передача выполняется' : 'Результат требует сверки')}</p>{doc.lastError && <p className="shipment-error">{doc.lastError}</p>}<p className="etrn-note">Последнее обновление: {workflowTime(doc.updatedAt)} · Москва.</p><p className="etrn-note">Подпись: {doc.signatureStatus === 'reported_by_saby' ? 'Saby сообщает о наличии подписи' : 'Пока не подтверждена'}. ГИС ЭПД: {doc.gisStatus || 'подтверждение не получено'}.</p>{!!doc.availableActions?.length && <p className="etrn-note">Следующее действие в Saby: {doc.availableActions.join(' · ')}.</p>}{url && <a className="button" href={url} target="_blank" rel="noreferrer">Открыть ЭТрН в Saby <ArrowUpRight size={14}/></a>}<ul>{doc.files.map(file => <li key={file.id}>{file.url.startsWith(`${etrnEndpoint}/files/${encodeURIComponent(delivery.shipmentId)}/`) && <a href={apiUrl(file.url)} download><Download size={14}/>{file.name}</a>}</li>)}</ul></section>
    })}
    {!!result?.history?.length && <details className="workflow-history"><summary>История обмена <span>{result.history.length}</span></summary><ol>{[...result.history].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><span>{exchangeStageLabels[entry.stage] ?? 'Состояние обновлено'}</span><time dateTime={entry.at}>{workflowTime(entry.at)}</time></li>)}</ol></details>}
    {haveLegacy && <details><summary>Ранее созданные документы</summary><p>Сохранённые связи доступны для сверки. Общая заявка поверх прежнего обмена автоматически не создаётся.</p>{legacy?.saby.documents.map(doc => <p key={doc.shipmentId}>{safeSabyUrl(doc.url) ? <a href={safeSabyUrl(doc.url)!} target="_blank" rel="noreferrer">Открыть прежний заказ в Saby</a> : doc.lastError || doc.status}</p>)}</details>}
  </section>
}
