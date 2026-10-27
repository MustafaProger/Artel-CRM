import { useEffect, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { LoaderCircle, Save, X } from 'lucide-react'
import DirectorySelect from './DirectorySelect'
import DeliveryPointPicker from './DeliveryPointPicker'
import type { Company, Directories } from './model'
import type { TripRequest } from './trip-request-model'
import { getDeliveryPlaceDisplay } from './trip-request-display'
import { tripRequestExplicitCoordinates, tripRequestMapCoordinates } from './trip-request-map-coordinates'
import { directoryLocationTarget, locationStatusText, requestLocationTarget, useTripRequestLocations } from './useTripRequestLocations'
import { apiFetch as fetch } from './workspace-api'
import { useDialogMotion } from './useDialogMotion'
import './trip-requests.css'

const normalizeAddress = (value: string) => value.trim().replace(/\s+/g, ' ')

function matchesSubmittedPoint(latest: TripRequest, submitted: { address?: string; latitude?: string; longitude?: string }, previous: TripRequest) {
  if (latest.address !== (submitted.address ?? previous.address)) return false
  if (submitted.latitude === undefined && submitted.longitude === undefined) return submitted.address !== undefined && submitted.address !== previous.address ? latest.latitude === null && latest.longitude === null && latest.mapUrl === null : latest.latitude === previous.latitude && latest.longitude === previous.longitude && latest.mapUrl === previous.mapUrl
  try {
    const latitude = new Decimal(submitted.latitude!).toFixed(), longitude = new Decimal(submitted.longitude!).toFixed()
    const url = new URL('https://yandex.ru/maps/')
    url.searchParams.set('pt', `${longitude},${latitude}`); url.searchParams.set('z', '16')
    return latest.latitude === latitude && latest.longitude === longitude && latest.mapUrl === url.href
  } catch { return false }
}

export default function TripRequestEditor({ request, companies, directories, onClose: onDismiss, onSaved }: {
  request?: TripRequest; companies: Company[]; directories: Directories; onClose: () => void; onSaved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), errorElement = useRef<HTMLDivElement>(null), busy = useRef(false)
  const idempotencyKey = useRef(crypto.randomUUID()), retryBody = useRef<string | null>(null)
  const [companyId, setCompanyId] = useState(request?.companyId ?? ''), [addressId, setAddressId] = useState(request?.addressId ?? '')
  const [quantityLitres, setQuantityLitres] = useState(request?.quantityLitres ?? ''), [comment, setComment] = useState(request?.comment ?? '')
  const [salePricePerLitre, setSalePricePerLitre] = useState(request?.salePricePerLitre ?? '')
  const [savedRequest, setSavedRequest] = useState(request)
  const [deliveryAddress, setDeliveryAddress] = useState(request?.address ?? '')
  const [point, setPoint] = useState<{ latitude: string; longitude: string } | null>(null)
  const [version, setVersion] = useState(request?.version ?? 0), [latestRequest, setLatestRequest] = useState<TripRequest | null>(null), [unavailable, setUnavailable] = useState(false)
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [discard, setDiscard] = useState(false)
  const { close: dismiss, complete } = useDialogMotion(dialog, onDismiss)
  const disabled = saving || uncertain
  const addresses = directories.addresses.filter(address => address.companyId === companyId && address.kind === 'delivery')
  const selectedAddress = addresses.find(address => address.id === addressId)
  const selectedAddressText = selectedAddress?.address || selectedAddress?.name || ''
  const requestPlace = request ? getDeliveryPlaceDisplay(request.addressName, request.address) : null
  const addressChanged = normalizeAddress(deliveryAddress) !== (savedRequest?.address ?? selectedAddressText)
  const dirty = companyId !== (savedRequest?.companyId ?? '') || addressId !== (savedRequest?.addressId ?? '') || quantityLitres !== (savedRequest?.quantityLitres ?? '') || salePricePerLitre !== (savedRequest?.salePricePerLitre ?? '') || comment !== (savedRequest?.comment ?? '') || point !== null || addressChanged
  const inheritedPoint = addressChanged ? null : savedRequest ? tripRequestMapCoordinates(savedRequest, addresses) : selectedAddress ? tripRequestExplicitCoordinates(selectedAddress) : null
  const geocodeTarget = addressChanged ? null : savedRequest ? savedRequest.status === 'active' ? requestLocationTarget(savedRequest) : null : selectedAddress ? directoryLocationTarget(selectedAddress) : null
  const { states: locations, retry: retryLocation } = useTripRequestLocations(!point && !inheritedPoint && geocodeTarget ? [geocodeTarget] : [])
  const automaticPoint = geocodeTarget ? locations.get(geocodeTarget.key) : undefined
  const resolvedPoint = inheritedPoint ?? automaticPoint
  const shownPoint = point ?? (resolvedPoint?.status === 'found' ? { latitude: String(resolvedPoint.latitude), longitude: String(resolvedPoint.longitude) } : null)
  useEffect(() => { if (error) errorElement.current?.focus() }, [error])
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const close = () => {
    if (busy.current) return
    if (uncertain) { setError('Результат сохранения пока неизвестен. Повторите сохранение, чтобы проверить тот же запрос.'); return }
    if (dirty) setDiscard(true); else dismiss()
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy.current || unavailable || latestRequest) return
    let body = retryBody.current
    if (!body) {
      let litres: string
      try {
        const value = quantityLitres.replace(/\s/g, '').replace(',', '.')
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !new Decimal(value).gt(0)) throw new Error()
        litres = new Decimal(value).toFixed()
      } catch { setError('Укажите количество литров больше нуля.'); return }
      let price: string | null = null
      if (salePricePerLitre.trim()) {
        try {
          const value = salePricePerLitre.replace(/\s/g, '').replace(',', '.')
          if (salePricePerLitre.length > 40 || !/^\d+(?:\.\d{1,6})?$/.test(value) || !new Decimal(value).gt(0)) throw new Error()
          price = new Decimal(value).toFixed()
        } catch { setError('Укажите цену за литр больше нуля, до 6 знаков после запятой.'); return }
      }
      if (!companyId || !addressId || !request && !selectedAddressText.trim()) { setError('Выберите компанию и место доставки с заполненным адресом из справочника.'); return }
      if (!normalizeAddress(deliveryAddress)) { setError('Укажите адрес доставки.'); return }
      const payload = request ? { version, ...(addressChanged ? { address: normalizeAddress(deliveryAddress) } : {}), quantityLitres: litres, salePricePerLitre: price, comment: comment.trim(), ...point } : { idempotencyKey: idempotencyKey.current, companyId, addressId, ...(addressChanged ? { address: normalizeAddress(deliveryAddress) } : {}), quantityLitres: litres, salePricePerLitre: price, comment: comment.trim(), ...point }
      body = JSON.stringify(payload)
    }
    const submitted = JSON.parse(body) as { quantityLitres: string; salePricePerLitre: string | null; comment: string; address?: string; latitude?: string; longitude?: string }
    retryBody.current = body; busy.current = true; setSaving(true); setError('')
    try {
      const response = await fetch(request ? `/api/trip-requests/${encodeURIComponent(request.id)}` : '/api/trip-requests', { method: request ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        if (request && response.status === 409) {
          const read = await fetch('/api/trip-requests', { signal: AbortSignal.timeout(10000) })
          if (read.ok) {
            const latest = ((await read.json()).requests as TripRequest[]).find(item => item.id === request.id)
            if (latest?.quantityLitres === submitted.quantityLitres && (latest.salePricePerLitre ?? null) === submitted.salePricePerLitre && latest.comment === submitted.comment && matchesSubmittedPoint(latest, submitted, savedRequest!)) { await complete(onSaved); return }
            if (latest) setLatestRequest(latest); else setUnavailable(true)
          }
        }
        if (response.status < 500) { retryBody.current = null; setUncertain(false) }
        else setUncertain(true)
        throw new Error(result.error || 'Не удалось сохранить заявку.')
      }
      await complete(onSaved)
    } catch (reason) {
      if (retryBody.current) setUncertain(true)
      setError(reason instanceof Error ? reason.message : 'Не удалось получить ответ сервера.')
    } finally { busy.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="shipment-editor trip-request-editor" aria-labelledby="trip-request-title" onCancel={event => { event.preventDefault(); close() }}>
    <form onSubmit={save} noValidate>
      <header className="shipment-editor-heading"><div><span>ЗАЯВКА НА ДОСТАВКУ</span><h2 id="trip-request-title">{request ? 'Изменить заявку' : 'Новая заявка'}</h2></div><button type="button" className="icon-button" aria-label="Закрыть заявку" disabled={saving} onClick={close}><X size={22}/></button></header>
      <div className="shipment-editor-body">
        <p className="shipment-editor-note">{request ? 'Уточните адрес доставки, количество литров, цену для клиента или комментарий.' : 'Выберите компанию и одну из её площадок. Литры, цена для клиента и комментарий будут перенесены в рейс.'}</p>
        {error && <div ref={errorElement} className="shipment-error" role="alert" tabIndex={-1}>{error}</div>}
        {latestRequest && <button type="button" className="button" disabled={saving} onClick={() => { setVersion(latestRequest.version); setQuantityLitres(latestRequest.quantityLitres); setSalePricePerLitre(latestRequest.salePricePerLitre ?? ''); setComment(latestRequest.comment); setSavedRequest(latestRequest); setDeliveryAddress(latestRequest.address); setPoint(null); setLatestRequest(null); setError(''); setDiscard(false) }}>Загрузить актуальную заявку</button>}
        {unavailable && <p className="shipment-calculation-warning" role="status">Заявка уже удалена или включена в рейс. Закройте форму, чтобы обновить список.</p>}
        {uncertain && <p className="shipment-calculation-warning" role="status">Ответ пока не подтверждён. Повторное сохранение проверит тот же запрос.</p>}
        <div className="trip-request-form">
          {request && requestPlace ? <div className="trip-request-place"><strong>{request.companyName}</strong><dl className="trip-request-location">{requestPlace.name && <div><dt>Площадка</dt><dd>{requestPlace.name}</dd></div>}</dl></div> : <>
            <DirectorySelect label="Компания" required entries={companies.filter(company => !company.directoryArchived && company.roles.includes('customer')).map(company => ({ id: company.id, name: company.name, detail: company.inn ? `ИНН ${company.inn}` : undefined }))} value={companyId} disabled={disabled} onChange={id => { setCompanyId(id); setAddressId(''); setDeliveryAddress(''); setPoint(null); setError(''); setDiscard(false) }}/>
            <DirectorySelect label="Место доставки" required wrapSelection entries={addresses.map(address => { const place = getDeliveryPlaceDisplay(address.name, address.address); return { id: address.id, name: place.name || place.address, detail: place.name ? `Адрес: ${place.address}` : undefined } })} value={addressId} disabled={disabled || !companyId} emptyMessage="У компании нет мест доставки. Добавьте место в справочнике." onChange={id => { setAddressId(id); const selected = addresses.find(address => address.id === id); setDeliveryAddress(selected?.address || selected?.name || ''); setPoint(null); setError(''); setDiscard(false) }}/>
          </>}
          {(request || selectedAddress) && <div className="trip-request-address-input"><label className="shipment-field"><span>Адрес доставки *</span><textarea rows={3} maxLength={2000} value={deliveryAddress} disabled={disabled} required onChange={event => { setDeliveryAddress(event.target.value); setPoint(null); setError(''); setDiscard(false) }}/></label><small className="trip-request-address-hint">Точка определяется автоматически после сохранения. Изменение адреса действует только для этой заявки.</small></div>}
          {addressChanged && <p className="trip-request-geocode-status" role="status">Найдём уточнённый адрес после сохранения.</p>}
          {automaticPoint && <div className="trip-request-geocode-status" role="status"><span>{locationStatusText(automaticPoint)}</span>{automaticPoint.status === 'unavailable' && geocodeTarget && <button type="button" className="button" disabled={disabled} onClick={() => retryLocation(geocodeTarget)}>Повторить поиск адреса</button>}</div>}
          {(request || selectedAddress) && <DeliveryPointPicker key={`${addressId}-${version}-${addressChanged ? 'changed' : 'saved'}`} latitude={shownPoint?.latitude} longitude={shownPoint?.longitude} mapUrl={point || addressChanged ? null : savedRequest ? savedRequest.mapUrl : selectedAddress?.mapUrl} disabled={disabled} onChange={(latitude, longitude) => { setPoint({ latitude, longitude }); setError(''); setDiscard(false) }}/>}
          <label className="shipment-field"><span>Количество литров, л *</span><input inputMode="decimal" value={quantityLitres} disabled={disabled} required onChange={event => { setQuantityLitres(event.target.value); setError(''); setDiscard(false) }}/></label>
          <label className="shipment-field"><span>Цена за литр для клиента, ₽</span><input aria-label="Цена за литр для клиента, ₽" inputMode="decimal" maxLength={40} value={salePricePerLitre} disabled={disabled} onChange={event => { setSalePricePerLitre(event.target.value); setError(''); setDiscard(false) }}/><small>Необязательно. В рейсе цену можно изменить.</small></label>
          <label className="shipment-field"><span>Комментарий</span><textarea rows={3} maxLength={4000} value={comment} disabled={disabled} onChange={event => { setComment(event.target.value); setError(''); setDiscard(false) }}/></label>
        </div>
      </div>
      <footer className="shipment-editor-footer">{discard ? <div className="shipment-discard" role="alert"><span>Есть несохранённые изменения.</span><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить</button><button type="button" className="button danger" onClick={dismiss}>Закрыть без сохранения</button></div> : <><button type="button" className="button" disabled={saving} onClick={close}>Отмена</button><button type="submit" className="button primary" disabled={saving || unavailable || !!latestRequest || !!request && !dirty}>{saving ? <LoaderCircle className="spin" size={17}/> : <Save size={17}/>} {uncertain ? 'Повторить сохранение' : 'Сохранить заявку'}</button></>}</footer>
    </form>
  </dialog>
}
