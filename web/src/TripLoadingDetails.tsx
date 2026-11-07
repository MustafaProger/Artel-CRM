import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Save } from 'lucide-react'
import { apiFetch } from './workspace-api'
import type { EtrnLoadingDetails, EtrnLoadingDocumentBasis } from './etrn-model'

interface LoadingDetailsResponse {
  details: EtrnLoadingDetails | null
  editable: boolean
  required: boolean
  autoContinuation?: boolean
  mode?: 'sender' | 'depot'
  loadingActor: { name: string; inn: string } | null
  infrastructureOwner?: { name: string; inn: string } | null
  carrierResponsible?: { surname: string; name: string; patronymic: string; phone: string } | null
  version: string
}

const emptyBasis = (): EtrnLoadingDocumentBasis => ({ name: '', number: '', date: '', issuerInns: [] })
const emptyDetails = (): EtrnLoadingDetails => ({ basis: emptyBasis(), worker: { surname: '', name: '', patronymic: '', position: '', authority: '' } })
const cleanBasis = (basis: EtrnLoadingDocumentBasis): EtrnLoadingDocumentBasis => ({ ...basis, issuerInns: basis.issuerInns.map(inn => inn.trim()).filter(Boolean) })
const cleanDetails = (details: EtrnLoadingDetails): EtrnLoadingDetails => ({
  basis: cleanBasis(details.basis),
  worker: { ...details.worker, ...(details.worker.authorityDocument ? { authorityDocument: cleanBasis(details.worker.authorityDocument) } : {}) },
})
const basisDescription = (basis?: EtrnLoadingDocumentBasis) => !basis ? 'Не указан' : [
  basis.documentId ? `Электронный документ: ${basis.documentId}` : [basis.name, basis.number && `№ ${basis.number}`, basis.date].filter(Boolean).join(' · '),
  basis.issuerInns.length ? `ИНН сторон: ${basis.issuerInns.join(', ')}` : '', basis.additionalInfo,
].filter(Boolean).join('; ') || 'Не указан'

function DocumentFields({ value, onChange, title }: { value: EtrnLoadingDocumentBasis; onChange: (value: EtrnLoadingDocumentBasis) => void; title: string }) {
  const electronic = value.documentId !== undefined
  return <fieldset className="trip-loading-document">
    <legend>{title}</legend>
    <div className="trip-loading-grid">
      <label className="shipment-field trip-loading-wide"><span>Как указать документ</span><select value={electronic ? 'electronic' : 'requisites'} onChange={event => {
        const { documentId: _documentId, ...paper } = value
        onChange(event.target.value === 'electronic' ? { ...value, name: '', number: '', date: '', documentId: '' } : paper)
      }}><option value="requisites">Реквизиты документа</option><option value="electronic">Электронный документ</option></select></label>
      {electronic ? <label className="shipment-field trip-loading-wide"><span>Идентификатор электронного документа</span><input value={value.documentId || ''} maxLength={1000} onChange={event => onChange({ ...value, documentId: event.target.value })}/></label> : <>
        <label className="shipment-field trip-loading-wide"><span>Наименование документа</span><input value={value.name} maxLength={255} onChange={event => onChange({ ...value, name: event.target.value })}/></label>
        <label className="shipment-field"><span>Номер документа</span><input value={value.number} maxLength={1000} onChange={event => onChange({ ...value, number: event.target.value })}/><small>Если у документа нет номера, укажите «Без номера».</small></label>
        <label className="shipment-field"><span>Дата документа</span><input type="date" value={value.date} onChange={event => onChange({ ...value, date: event.target.value })}/></label>
      </>}
      <label className="shipment-field trip-loading-wide"><span>ИНН сторон документа</span><input value={value.issuerInns.join(', ')} onChange={event => onChange({ ...value, issuerInns: event.target.value.split(/[,;\n]/).map(inn => inn.trim()) })}/><small>Укажите ИНН из документа. Несколько ИНН разделите запятой.</small></label>
      {value.additionalInfo && <p className="etrn-note trip-loading-wide">Дополнительные сведения: {value.additionalInfo}</p>}
    </div>
  </fieldset>
}

export default function TripLoadingDetails({ tripId, disabled, locked, onSaved }: { tripId: string; disabled: boolean; locked: boolean; onSaved: () => Promise<void> }) {
  const endpoint = `/api/shipment-trips/${encodeURIComponent(tripId)}/etrn/loading-details`
  const [record, setRecord] = useState<LoadingDetailsResponse | null>(null)
  const [details, setDetails] = useState<EtrnLoadingDetails>(emptyDetails)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false)
  const mounted = useRef(true), saveLock = useRef(false)

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void apiFetch(endpoint, { signal: controller.signal }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Не удалось загрузить сведения о погрузке')
      if (mounted.current && !controller.signal.aborted) { setRecord(body); setDetails(body.details || emptyDetails()) }
    }).catch(reason => {
      if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить сведения о погрузке')
    }).finally(() => { if (mounted.current && !controller.signal.aborted) setLoading(false) })
    return () => { mounted.current = false; controller.abort() }
  }, [endpoint])

  const reload = async () => {
    setLoading(true); setError(''); setMessage('')
    try {
      const response = await apiFetch(endpoint), body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Не удалось загрузить сведения о погрузке')
      if (mounted.current) { setRecord(body); setDetails(body.details || emptyDetails()); setConflict(false) }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
    finally { if (mounted.current) setLoading(false) }
  }
  const save = async () => {
    if (!record?.editable || locked || disabled || conflict || saveLock.current) return
    saveLock.current = true; setSaving(true); setError(''); setMessage('')
    try {
      const response = await apiFetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details: cleanDetails(details), version: record.version }) })
      const body = await response.json()
      if (!response.ok) {
        if (response.status === 409 && mounted.current) setConflict(true)
        throw new Error(body.error || 'Не удалось сохранить сведения о погрузке')
      }
      if (mounted.current) { setRecord(body); setDetails(body.details || emptyDetails()); setMessage('Сведения сохранены для этого рейса.') }
      await onSaved().catch(() => { if (mounted.current) setMessage('Сведения сохранены. Обновить готовность ЭТрН пока не удалось.') })
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Ответ о сохранении не получен. Загрузите сохранённые сведения, чтобы проверить результат.') }
    finally { saveLock.current = false; if (mounted.current) setSaving(false) }
  }
  const update = (value: EtrnLoadingDetails) => { setDetails(value); setMessage('') }
  const editable = record?.editable && !locked
  const dirty = JSON.stringify(cleanDetails(details)) !== JSON.stringify(cleanDetails(record?.details || emptyDetails()))

  if (record?.mode === 'sender') return <section className="trip-loading-details" aria-label="Сведения о погрузке">
    <header><h4>Погрузка в этом рейсе</h4></header>
    <p className="trip-loading-actor"><span>Отправитель:</span><strong>{record.loadingActor?.name || 'Организация не указана'}</strong></p>
    <p className="etrn-note">Отдельное лицо в поле «Отгружает» не указывается. Документ-основание и сотрудник погрузки не требуются.</p>
    {record.infrastructureOwner && <p className="trip-loading-actor"><span>Владелец нефтебазы:</span><strong>{record.infrastructureOwner.name}</strong></p>}
    {record.carrierResponsible && <p className="trip-loading-actor"><span>Ответственный НК:</span><strong>{[record.carrierResponsible.surname, record.carrierResponsible.name, record.carrierResponsible.patronymic].filter(Boolean).join(' ')}</strong></p>}
  </section>
  if (record && !record.required) return null
  return <section className="trip-loading-details" aria-label="Сведения о погрузке" aria-busy={loading || saving}>
    <header><h4>Кто передаёт груз перевозчику</h4>{(loading || saving) && <LoaderCircle size={18} className="spin" aria-label={saving ? 'Сохранение сведений' : 'Загрузка сведений'}/>}</header>
    {record?.loadingActor ? <p className="trip-loading-actor"><strong>{record.loadingActor.name}</strong><span>ИНН {record.loadingActor.inn}</span></p> : !loading && record && <p className="workflow-sync-warning">Организация, выполняющая погрузку, ещё не подтверждена. Сначала уточните её в данных рейса.</p>}
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {message && <p className="etrn-note" role="status">{message}</p>}
    {!record && !loading && <button type="button" className="button" onClick={() => void reload()}>Загрузить сведения</button>}
    {record && editable && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <p className="etrn-note">Укажите документ, по которому эта организация передаёт груз от имени НК АРТЭЛЬ, и сотрудника, ответственного за погрузку. Заполняйте по фактическим сведениям этого рейса. Можно сохранить часть данных и дополнить позже.</p>
      {record.autoContinuation && <p className="etrn-note">Если водитель уже убыл, после заполнения всех сведений обработка ЭТрН продолжится автоматически.</p>}
      <fieldset className="trip-loading-fields" disabled={disabled || saving || loading || conflict}>
        <DocumentFields title="Основание погрузки" value={details.basis} onChange={basis => update({ ...details, basis })}/>
        <fieldset className="trip-loading-document"><legend>Сотрудник, ответственный за погрузку</legend><div className="trip-loading-grid">
          {([['surname', 'Фамилия'], ['name', 'Имя'], ['patronymic', 'Отчество, если есть'], ['position', 'Должность']] as const).map(([key, label]) => <label className="shipment-field" key={key}><span>{label}</span><input maxLength={key === 'position' ? 128 : 60} value={details.worker[key]} onChange={event => update({ ...details, worker: { ...details.worker, [key]: event.target.value } })}/></label>)}
          <label className="shipment-field trip-loading-wide"><span>Основание полномочий сотрудника</span><select value={details.worker.authority} onChange={event => {
            const authority = event.target.value as EtrnLoadingDetails['worker']['authority']
            const { authorityDocument: _authorityDocument, ...worker } = details.worker
            update({ ...details, worker: { ...worker, authority, ...(authority === 'document' ? { authorityDocument: emptyBasis() } : {}) } })
          }}><option value="">Выберите основание</option><option value="job_duties">Должностные обязанности</option><option value="document">Доверенность / документ</option></select></label>
          {details.worker.additionalInfo && <p className="etrn-note trip-loading-wide">Дополнительные сведения: {details.worker.additionalInfo}</p>}
        </div></fieldset>
        {details.worker.authority === 'document' && <DocumentFields title="Документ о полномочиях сотрудника" value={details.worker.authorityDocument || emptyBasis()} onChange={authorityDocument => update({ ...details, worker: { ...details.worker, authorityDocument } })}/>}
      </fieldset>
      {conflict && <p className="workflow-sync-warning" role="status">Сохранённые сведения изменились. Загрузите их перед дальнейшим редактированием — несохранённый ввод будет заменён.</p>}
      <div className="etrn-actions"><button type="submit" className="button primary" disabled={disabled || saving || loading || conflict || !dirty}><Save size={16}/>Сохранить сведения</button>{(conflict || error) && <button type="button" className="button" disabled={saving || loading} onClick={() => void reload()}>Загрузить сохранённые сведения</button>}</div>
    </form>}
    {record && !editable && <>
      <p className="etrn-note">Обмен уже начат. Сведения о погрузке доступны для просмотра.</p>
      {record.details ? <dl className="trip-loading-summary">
        <div><dt>Основание погрузки</dt><dd>{basisDescription(record.details.basis)}</dd></div>
        <div><dt>Ответственный сотрудник</dt><dd>{[record.details.worker.surname, record.details.worker.name, record.details.worker.patronymic].filter(Boolean).join(' ') || 'Не указан'}{record.details.worker.position && ` · ${record.details.worker.position}`}</dd></div>
        <div><dt>Основание полномочий</dt><dd>{record.details.worker.authority === 'job_duties' ? 'Должностные обязанности' : record.details.worker.authority === 'document' ? basisDescription(record.details.worker.authorityDocument) : 'Не указано'}</dd></div>
        {record.details.worker.additionalInfo && <div><dt>Дополнительные сведения</dt><dd>{record.details.worker.additionalInfo}</dd></div>}
      </dl> : <p className="etrn-note">Документ-основание и ответственный сотрудник для этого рейса не сохранены.</p>}
    </>}
  </section>
}
