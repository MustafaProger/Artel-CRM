import { useEffect, useMemo, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { ChevronDown, LoaderCircle, Plus, Save, Trash2, Truck, X } from 'lucide-react'
import DirectorySelect, { type SelectEntry } from './DirectorySelect'
import type { ShipmentEditorProps } from './ShipmentEditor'
import type { ShipmentAddress } from './model'
import TripLocationPicker from './TripLocationPicker'
import './trips.css'
import './form-refinements.css'
import { calculateShipment, daysSinceShipment, today, unpaidShipmentDays } from './shipment-calculations'
import { customerManagerId, availableShipmentCustomer } from './customer-manager'
import { allocateTrip } from './trip-calculations'
import { number } from './utils'
import { isOurOrganizationId, ourOrganizations } from './our-organizations'
import { type TripIntermediateStop } from './trip-route'
import { isUnpackagedDiesel } from './trip-input-rules'
import { driverVehicleId, initialUnloadingFields, loadingDateFields } from './trip-editor-rules'

interface CustomerDraft {
  key: string
  id?: string
  paidAmount?: string | null
  fields: Record<string, string>
}
interface TripDraft {
  fields: Record<string, string>
  customers: CustomerDraft[]
}
interface LoadedTrip {
  id: string
  fields: Record<string, string | null>
  customers: { id: string; version: number; paidAmount: string | null; fields: Record<string, string | null> }[]
}

const normalizedFields = (fields: Record<string, string | null>) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? '']))
const numericValue = (value: string) => {
  const normalized = value.replace(/\s/g, '').replace(',', '.')
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null
  const parsed = new Decimal(normalized)
  return parsed.isFinite() ? parsed : null
}
const serialize = (draft: TripDraft) => JSON.stringify(draft)
const numericKeys = new Set(['purchase_price_unspecified_unit', 'quantity_tonnes', 'additional_costs', 'quantity_litres', 'sale_price_per_litre', 'transport_amount'])
const comparable = (key: string, value: string | null | undefined) => numericKeys.has(key) && value ? numericValue(value)?.toFixed() ?? value : value?.trim() || null
const sameFields = (expected: Record<string, string | null>, actual: Record<string, string | null>) => Object.entries(expected).every(([key, value]) => key === 'loading_at'
  ? actual.date === value?.slice(0, 10) && actual.loading_planned_at === value && actual.loading_actual_at === value
  : comparable(key, value) === comparable(key, actual[key]))

interface TripEditorProps extends ShipmentEditorProps { tripId?: string; tripMode?: boolean; canManagePlaces?: boolean; onDirectoriesChanged?: () => void }

export default function ShipmentTripEditor({ shipment, companies, directories, defaultPaymentForm = 'б/нал', onClose, onSaved, tripId: selectedTripId, tripMode = false, canManagePlaces = false, onDirectoriesChanged }: TripEditorProps) {
  const tripId = selectedTripId ?? shipment?.fields.trip_id
  const idempotencyKey = useRef(crypto.randomUUID())
  const savingLock = useRef(false)
  const retryPayload = useRef<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [addedAddresses, setAddedAddresses] = useState<ShipmentAddress[]>([])
  const addresses = [...directories.addresses, ...addedAddresses.filter(item => !directories.addresses.some(existing => existing.id === item.id))]
  const dialog = useRef<HTMLDialogElement>(null)
  const errorElement = useRef<HTMLDivElement>(null)
  const pendingCustomerFocus = useRef<string | null>(null)
  const manuallyEditedUnloading = useRef(new Set<string>())
  const defaultPaymentId = directories.paymentForms.find(p => p.name === defaultPaymentForm)?.id ?? ''
  const newCustomer = (loadingAt = today()): CustomerDraft => ({
    key: crypto.randomUUID(),
    fields: { customer_id: '', payment_form_id: defaultPaymentId, quantity_litres: '', sale_price_per_litre: '', transport_amount: '0', unloading_address_id: '', manager_id: '', invoice_not_required: 'false', delivery_notes: '', ...initialUnloadingFields(loadingAt) },
  })
  const [draft, setDraft] = useState<TripDraft>(() => ({
    fields: { organization_id: tripMode ? 'artel' : '', ...loadingDateFields(today()), supplier_id: '', oil_depot_id: '', carrier_id: '', loading_address_id: '', purchase_price_unspecified_unit: '', quantity_tonnes: '', product_id: '', driver_id: '', vehicle_id: '', additional_costs: '0', trip_notes: '', intermediate_stops_in_order: '' },
    customers: [newCustomer()],
  }))
  const [initial, setInitial] = useState(() => serialize(draft))
  const [versions, setVersions] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(!!tripId)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const dirty = serialize(draft) !== initial
  const fields = draft.fields
  const disabled = saving || loading || uncertain

  useEffect(() => {
    const element = dialog.current
    const focused = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    element?.showModal()
    document.body.style.overflow = 'hidden'
    return () => { element?.close(); document.body.style.overflow = oldOverflow; focused?.focus() }
  }, [])

  useEffect(() => {
    if (!tripId) return
    const controller = new AbortController()
    const load = async () => {
      setLoading(true)
      setLoadError('')
      try {
        const response = await fetch(`/api/shipment-trips/${encodeURIComponent(tripId)}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Не удалось загрузить отгрузку')
        const trip: LoadedTrip = result.trip
        if (!trip?.customers?.length) throw new Error('В отгрузке не найдены клиенты')
        const loaded = { fields: normalizedFields(trip.fields), customers: trip.customers.map(customer => ({ key: customer.id, id: customer.id, paidAmount: customer.paidAmount, fields: normalizedFields(customer.fields) })) }
        setDraft(loaded)
        setInitial(serialize(loaded))
        setVersions(Object.fromEntries(trip.customers.map(customer => [customer.id, customer.version])))
        setConflict(false)
        setError('')
      } catch (reason) {
        if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : 'Нет связи с сервером')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [tripId, reload])

  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])

  useEffect(() => {
    if (error) errorElement.current?.focus()
  }, [error])

  useEffect(() => {
    if (!pendingCustomerFocus.current) return
    const card = Array.from(dialog.current?.querySelectorAll<HTMLElement>('[data-customer-key]') ?? []).find(element => element.dataset.customerKey === pendingCustomerFocus.current)
    card?.querySelector<HTMLInputElement>('input')?.focus()
    pendingCustomerFocus.current = null
  }, [draft.customers])

  const allocation = useMemo(() => {
    try { return allocateTrip(fields.quantity_tonnes, draft.customers.map(customer => customer.fields.quantity_litres), fields.additional_costs || '0') }
    catch { return null }
  }, [fields.quantity_tonnes, fields.additional_costs, draft.customers])
  const totalLitres = draft.customers.reduce((total, customer) => total.plus(numericValue(customer.fields.quantity_litres) ?? 0), new Decimal(0))
  const unpaidDays = draft.customers.some(customer => {
    const litres = numericValue(customer.fields.quantity_litres), price = numericValue(customer.fields.sale_price_per_litre)
    return unpaidShipmentDays(fields.date, litres && price ? litres.times(price).toFixed() : null, customer.paidAmount ?? '0') !== null
  }) ? daysSinceShipment(fields.date) : null
  const driver = directories.drivers.find(entry => entry.id === fields.driver_id)
  const vehicle = directories.vehicles.find(entry => entry.id === fields.vehicle_id)
  const capacity = vehicle?.capacityLitres == null ? null : numericValue(String(vehicle.capacityLitres))
  const overCapacity = capacity != null && capacity.gt(0) && totalLitres.gt(capacity)
  const companyEntries = (role: 'customer' | 'supplier', current: string) => companies.filter(company => (!company.directoryArchived && company.roles.includes(role)) || company.id === current).map(company => ({ id: company.id, name: company.name, detail: company.inn ? `ИНН ${company.inn}` : undefined }))
  const product = directories.products.find(entry => entry.id === fields.product_id)
  const unifiedCargoMass = isUnpackagedDiesel(product)
  const depot = directories.oilDepots?.find(entry => entry.id === fields.oil_depot_id)
  const vehicleEntries = directories.vehicles.map(entry => ({ id: entry.id, name: entry.name || entry.plate, detail: [entry.name && entry.name !== entry.plate ? entry.plate : '', entry.capacityLitres ? `${number(entry.capacityLitres)} л` : ''].filter(Boolean).join(' · ') }))

  const changed = () => { setConfirmClose(false); setError('') }
  const update = (key: string, value: string) => {
    setDraft(previous => {
      const next = { ...previous.fields, [key]: value }
      if (key === 'loading_at') Object.assign(next, loadingDateFields(value))
      if (key === 'oil_depot_id') Object.assign(next, { loading_address_id: '', loading_address: '', loading_map_url: '' })
      if (key === 'driver_id' && previous.fields.driver_id !== value) {
        next.vehicle_id = driverVehicleId(directories, value)
      }
      if ((key === 'quantity_tonnes' || key === 'product_id') && isUnpackagedDiesel(directories.products.find(entry => entry.id === next.product_id))) next.quantity_gross_tonnes = next.quantity_tonnes
      const customers = key === 'loading_at' ? previous.customers.map(customer => ({ ...customer, fields: {
        ...customer.fields,
        ...Object.fromEntries(['unloading_planned_at', 'unloading_actual_at'].filter(field => (!customer.fields[field] || !tripId && customer.fields[field] === (previous.fields.loading_at || previous.fields.loading_planned_at || previous.fields.date)) && !manuallyEditedUnloading.current.has(`${customer.key}:${field}`)).map(field => [field, value])),
      } })) : previous.customers
      return { ...previous, fields: next, customers }
    })
    changed()
  }
  const updateCustomer = (customerKey: string, key: string, value: string) => {
    if (key === 'unloading_planned_at' || key === 'unloading_actual_at') manuallyEditedUnloading.current.add(`${customerKey}:${key}`)
    setDraft(previous => ({ ...previous, customers: previous.customers.map(customer => customer.key !== customerKey ? customer : { ...customer, fields: { ...customer.fields, [key]: value, ...(key === 'unloading_address_id' ? { unloading_address: '', unloading_map_url: '' } : {}), ...(key === 'customer_id' ? { unloading_address_id: '', unloading_address: '', unloading_map_url: '', manager_id: customerManagerId(directories, value) } : {}) } }) }))
    changed()
  }
  const addCustomer = () => {
    const customer = newCustomer(fields.loading_at || fields.loading_planned_at || fields.date)
    pendingCustomerFocus.current = customer.key
    setDraft(previous => ({ ...previous, customers: [...previous.customers, customer] }))
    changed()
  }
  const removeCustomer = (key: string) => {
    const index = draft.customers.findIndex(customer => customer.key === key)
    pendingCustomerFocus.current = draft.customers[index - 1]?.key ?? draft.customers[index + 1]?.key ?? null
    setDraft(previous => ({ ...previous, customers: previous.customers.filter(customer => customer.key !== key) }))
    changed()
  }
  const stopsAfter = (customer: CustomerDraft): TripIntermediateStop[] => {
    try { return JSON.parse(customer.fields.intermediate_stops_after || '[]') as TripIntermediateStop[] } catch { return [] }
  }
  const changeStops = (customer: CustomerDraft, stops: TripIntermediateStop[]) => updateCustomer(customer.key, 'intermediate_stops_after', stops.length ? JSON.stringify(stops) : '')
  const close = () => { if (uncertain) { setError('Результат сохранения пока неизвестен. Повторите сохранение, чтобы получить результат без дублей.'); return } if (!saving) { if (dirty) setConfirmClose(true); else onClose() } }

  const validate = () => {
    if (!tripId && !isOurOrganizationId(fields.organization_id)) return 'Выберите нашу организацию: НК АРТЕЛЬ или АРТЕЛЬ.'
    if (!fields.date) return 'Укажите дату отгрузки.'
    if (!companies.some(company => company.id === fields.supplier_id)) return 'Выберите поставщика из списка.'
    if (!numericValue(fields.purchase_price_unspecified_unit)?.gt(0)) return 'Укажите цену поставщика за тонну больше нуля.'
    if (!numericValue(fields.quantity_tonnes)?.gt(0)) return 'Укажите плановую массу груза больше нуля.'
    if (!directories.products.some(product => product.id === fields.product_id)) return 'Выберите товар из списка.'
    for (const [index, customer] of draft.customers.entries()) {
      const values = customer.fields
      const prefix = `Клиент ${index + 1}: `
      if (!companies.some(company => company.id === values.customer_id)) return `${prefix}выберите клиента из списка.`
      if (!directories.paymentForms.some(payment => payment.id === values.payment_form_id)) return `${prefix}выберите форму оплаты.`
      if (!numericValue(values.quantity_litres)?.gt(0)) return `${prefix}укажите количество литров больше нуля.`
      if (!numericValue(values.sale_price_per_litre)?.gt(0)) return `${prefix}укажите цену за литр больше нуля.`
      if (!numericValue(values.transport_amount || '0')?.gte(0)) return `${prefix}сумма перевозки должна быть неотрицательным числом.`
      if (!directories.managers.some(manager => manager.id === values.manager_id)) return `${prefix}выберите менеджера.`
    }
    if (!driver) return 'Выберите водителя из списка.'
    if (!vehicle) return 'Выберите автомобиль из списка.'
    if (!numericValue(fields.additional_costs || '0')?.gte(0)) return 'Дополнительные затраты должны быть неотрицательным числом.'
    try { allocateTrip(fields.quantity_tonnes, draft.customers.map(customer => customer.fields.quantity_litres), fields.additional_costs || '0') }
    catch (reason) { return reason instanceof Error ? reason.message : 'Проверьте тоннаж и литры клиентов.' }
    return null
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (savingLock.current || loading || loadError || conflict) return
    const validationError = retryPayload.current ? null : validate()
    if (validationError) { setError(validationError); errorElement.current?.focus(); return }
    setError('')
    setSaving(true)
    savingLock.current = true
    const snapshotFields = new Set(['loading_address', 'loading_map_url', 'unloading_address', 'unloading_map_url', 'loading_latitude', 'loading_longitude', 'unloading_latitude', 'unloading_longitude'])
    const clean = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([key]) => !snapshotFields.has(key)).map(([key, value]) => [key, value.trim() || null]))
    const payload = {
      fields: clean({ ...fields, additional_costs: fields.additional_costs || '0' }),
      customers: draft.customers.map(customer => ({ ...(customer.id ? { id: customer.id } : {}), fields: clean({ ...customer.fields, transport_amount: customer.fields.transport_amount || '0' }) })),
      ...(tripId ? { versions } : { idempotencyKey: idempotencyKey.current }),
    }
    const body = retryPayload.current ?? JSON.stringify(payload)
    retryPayload.current = body
    const recoverPatch = async () => {
      if (!tripId) return false
      const response = await fetch(`/api/shipment-trips/${encodeURIComponent(tripId)}`, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) return false
      const result = await response.json(), current: LoadedTrip = result.trip
      const expected = JSON.parse(body) as typeof payload
      const remaining = [...current.customers]
      const identicalCustomers = expected.customers.length === remaining.length && expected.customers.every(customer => {
        const index = remaining.findIndex(row => (!customer.id || row.id === customer.id) && sameFields(customer.fields, row.fields))
        if (index < 0) return false
        remaining.splice(index, 1); return true
      })
      if (sameFields(expected.fields, current.fields) && identicalCustomers && result.shipment) { onSaved(result.shipment); return true }
      const priorVersions: Record<string, number> = 'versions' in expected ? expected.versions : {}
      if (current.customers.length !== Object.keys(priorVersions).length || current.customers.some(row => priorVersions[row.id] !== row.version)) {
        retryPayload.current = null; setUncertain(false); setConflict(true)
        throw new Error('Рейс изменён в другом окне. Загрузите актуальный рейс и проверьте изменения перед сохранением.')
      }
      return false
    }
    try {
      const response = await fetch(tripId ? `/api/shipment-trips/${encodeURIComponent(tripId)}` : '/api/shipment-trips', { method: tripId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        if (response.status === 409 && tripId && await recoverPatch()) return
        if (response.status < 500) { retryPayload.current = null; setUncertain(false) }
        else setUncertain(true)
        throw new Error(result.error || 'Не удалось сохранить отгрузку')
      }
      onSaved(result.shipment ?? result.shipments[0])
    } catch (reason) {
      let failure = reason
      if (tripId && retryPayload.current) {
        try { if (await recoverPatch()) return }
        catch (recoveryError) { failure = recoveryError }
      }
      if (retryPayload.current) setUncertain(true)
      setError(failure instanceof Error ? failure.message : 'Нет связи с сервером')
    }
    finally { savingLock.current = false; setSaving(false) }
  }

  const select = (label: string, key: string, entries: SelectEntry[], options: { required?: boolean; disabled?: boolean; customer?: CustomerDraft } = {}) => <DirectorySelect label={label} value={(options.customer?.fields ?? fields)[key] ?? ''} entries={entries} required={options.required} disabled={disabled || options.disabled} onChange={value => options.customer ? updateCustomer(options.customer.key, key, value) : update(key, value)}/>
  const input = (label: string, key: string, options: { required?: boolean; type?: string; customer?: CustomerDraft; text?: boolean } = {}) => <label className="shipment-field"><span>{label}{options.required && ' *'}</span><input type={options.type ?? 'text'} inputMode={options.type === 'date' || options.type === 'datetime-local' || options.text ? undefined : 'decimal'} autoFocus={key === 'date'} value={(options.customer?.fields ?? fields)[key] ?? ''} required={options.required} disabled={disabled} onChange={event => options.customer ? updateCustomer(options.customer.key, key, event.target.value) : update(key, event.target.value)}/></label>
  const location = (customer: CustomerDraft) => {
    const values = customer.fields
    return <TripLocationPicker label="Место выгрузки" kind="delivery" companyId={values.customer_id} value={values.unloading_address_id ?? ''} addresses={addresses} addressSnapshot={values.unloading_address || undefined} mapSnapshot={values.unloading_map_url || undefined} disabled={disabled} canManage={canManagePlaces} onChange={id => updateCustomer(customer.key, 'unloading_address_id', id)} onCreated={address => { setAddedAddresses(previous => [...previous.filter(item => item.id !== address.id), address]); onDirectoriesChanged?.() }}/>
  }
  const loadingValue = fields.loading_at ?? (fields.loading_planned_at || fields.date || '')
  const dateTimeInput = (label: string, value: string, onChange: (value: string) => void, required = false) => <div className="shipment-field trip-date-input">
    <span>{label}{required && ' *'}</span>
    <div className="trip-date-controls">
      <label><span className="form-control-caption">Дата</span><input aria-label={label} type="date" value={value.slice(0, 10)} required={required} disabled={disabled} onChange={event => onChange(event.target.value ? `${event.target.value}${value.includes('T') ? `T${value.split('T')[1]}` : ''}` : '')}/></label>
      <label><span className="form-control-caption" title="Время можно не указывать">Время</span><input aria-label={`${label} — время`} type="time" value={value.split('T')[1]?.slice(0, 5) ?? ''} disabled={disabled || !value.slice(0, 10)} onChange={event => onChange(`${value.slice(0, 10)}${event.target.value ? `T${event.target.value}` : ''}`)}/></label>
    </div>
  </div>
  const companyName = (id: string | undefined) => companies.find(company => company.id === id)?.name || 'Не указано'
  const output = (label: string, value: string | number | null | undefined, digits = 2) => <div className="shipment-calculated"><span>{label}</span><output aria-label={label}>{value == null || value === '' ? '—' : number(value, digits)}</output></div>

  return <dialog ref={dialog} className="shipment-editor shipment-trip-editor" aria-labelledby="shipment-trip-title" onCancel={event => { event.preventDefault(); close() }}>
    <form onSubmit={save} noValidate onKeyDown={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.getAttribute('role') !== 'combobox') {
        event.preventDefault()
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button[type="submit"]'))
        controls[controls.indexOf(event.target) + 1]?.focus()
      }
    }}>
      <header className="shipment-editor-heading"><div><span>{tripMode ? (tripId ? 'РЕДАКТИРОВАНИЕ РЕЙСА' : 'НОВЫЙ РЕЙС') : (tripId ? 'РЕДАКТИРОВАНИЕ ОТГРУЗКИ' : 'НОВАЯ ОТГРУЗКА')}</span><h2 id="shipment-trip-title">{tripMode ? (tripId ? 'Изменить рейс' : 'Новый рейс') : (tripId ? 'Изменить отгрузку' : 'Добавить отгрузку')}</h2></div><button type="button" className="icon-button" aria-label="Закрыть редактор" disabled={saving} onClick={close}><X size={23}/></button></header>
      <div className="shipment-editor-body" aria-busy={loading || saving}>
        {loading ? <div className="shipment-trip-loading" role="status"><LoaderCircle className="spin" size={24}/><span>Загружаем отгрузку и всех её клиентов…</span></div> : loadError ? <div className="shipment-trip-loading"><p className="shipment-error" role="alert">{loadError}</p><button type="button" className="button" onClick={() => setReload(value => value + 1)}>Повторить загрузку</button></div> : <>
          <p className="shipment-editor-note shipment-trip-intro">{tripMode ? 'Сохранение создаёт рабочий рейс и строки клиентов в «Отгрузках». Передать его в Saby можно после сохранения.' : 'Одна машина — одна отгрузка. Укажите общий тоннаж, затем литры и условия для каждого клиента.'}</p>
          {uncertain && <p className="shipment-calculation-warning" role="status">Ответ сервера не подтверждён. Повторите сохранение: будет проверен тот же запрос без создания второго рейса.</p>}
          {error && <div ref={errorElement} className="shipment-error" role="alert" tabIndex={-1}>{error}</div>}
          {conflict && <button type="button" className="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Загрузить актуальный рейс</button>}
          <fieldset className="shipment-fieldset group-purchase"><legend>Отгрузка и поставщик</legend><div className="shipment-field-grid">
            {select('Наша организация', 'organization_id', ourOrganizations.map(organization => ({ ...organization })), { required: !tripId })}
            {dateTimeInput('Дата отгрузки / погрузки', loadingValue, value => update('loading_at', value), true)}
            {tripMode && <label className="trip-invoice-option form-field-wide"><input type="checkbox" checked={fields.organization_id === 'nk-artel'} disabled={disabled} onChange={event => update('organization_id', event.target.checked ? 'nk-artel' : 'artel')}/>Собственный клиент НК Артэль — НК отправитель и перевозчик</label>}
            {select('Поставщик', 'supplier_id', companyEntries('supplier', draft.fields.supplier_id), { required: true })}
            {select('Нефтебаза', 'oil_depot_id', (directories.oilDepots ?? []).map(entry => ({ id: entry.id, name: entry.name, detail: entry.address })))}
            {select('Товар', 'product_id', directories.products, { required: true })}
            {input('Цена поставщика за тонну, ₽', 'purchase_price_unspecified_unit', { required: true })}
            {input('Плановая масса груза, т', 'quantity_tonnes', { required: true })}
            {tripMode && !unifiedCargoMass && input('Плановая масса брутто по документам, т', 'quantity_gross_tonnes')}
          </div>
          {unifiedCargoMass && <p className="shipment-editor-note">Дизельное топливо без упаковки: одна масса груза используется как нетто и брутто.</p>}
          {tripId && !fields.loading_at && (fields.loading_actual_at && fields.loading_actual_at !== fields.loading_planned_at || fields.loading_planned_at && fields.loading_planned_at.slice(0, 10) !== fields.date) && <p className="shipment-editor-note">Сохранены исторические даты: отгрузка {fields.date || 'не указана'}, плановая погрузка {fields.loading_planned_at || 'не указана'}, фактическая погрузка {fields.loading_actual_at || 'не указана'}. Они останутся разными, пока вы не измените общую дату погрузки.</p>}
          {depot ? <div className="shipment-trip-fleet"><div><p><span>Пункт подачи / место погрузки</span><strong>{fields.loading_address || depot.address || 'Заполните фактический адрес нефтебазы'}</strong></p><p><span>Владелец нефтебазы</span><strong>{companyName(depot.ownerCompanyId)}</strong></p><p><span>Юридический адрес владельца</span><strong>{companies.find(company => company.id === depot.ownerCompanyId)?.address || 'Не указан'}</strong></p><p><span>Лицо, осуществляющее погрузку</span><strong>{companyName(depot.loadingActorCompanyId)}</strong></p><p><span>Владелец инфраструктуры погрузки</span><strong>{companyName(depot.infrastructureOwnerCompanyId)}</strong></p></div></div> : fields.loading_address && <p className="shipment-editor-note">Историческое место погрузки: {fields.loading_address}. Для нового места выберите нефтебазу.</p>}
          {tripId&&!fields.organization_id&&<p className="shipment-editor-note">Организация старой отгрузки не указана. Выберите её только при подтверждённой принадлежности.</p>}</fieldset>

          <section className="shipment-trip-customers" aria-labelledby="shipment-trip-customers-title"><div className="shipment-trip-section-heading"><div><h3 id="shipment-trip-customers-title">Клиенты машины</h3><p>Тоннаж каждого клиента рассчитывается пропорционально его литрам.</p></div><span className="shipment-trip-count">{draft.customers.length}</span></div>
            {draft.customers.map((customer, index) => {
              const litres = numericValue(customer.fields.quantity_litres)
              const price = numericValue(customer.fields.sale_price_per_litre)
              const calculation = allocation ? calculateShipment({ ...fields, ...customer.fields, payment_form: directories.paymentForms.find(p => p.id === customer.fields.payment_form_id)?.name ?? null, quantity_tonnes: allocation.tonnes[index], additional_costs: allocation.additionalCosts[index] }, { sale: 'litres', purchase: 'tonnes', profit: directories.defaults.profit, debtSign: 'paid-minus-sale' }) : null
              return <fieldset key={customer.key} className="shipment-fieldset group-sale shipment-trip-customer" data-testid="trip-customer" data-customer-key={customer.key}>
                <legend>Клиент {index + 1}</legend>
                {draft.customers.length > 1 && <div className="shipment-trip-customer-actions"><button type="button" className="button shipment-trip-remove" aria-label={`Удалить клиента ${index + 1}`} disabled={disabled} onClick={() => removeCustomer(customer.key)}><Trash2 size={15}/>Удалить клиента {index + 1}</button></div>}
                <div className="shipment-field-grid">
                  {select('Клиент', 'customer_id', companyEntries('customer', customer.fields.customer_id).filter(company => availableShipmentCustomer(directories, company.id, customer.fields.customer_id)), { required: true, customer })}
                  {select('Форма оплаты', 'payment_form_id', directories.paymentForms, { required: true, customer })}
                  {input('Количество литров, л', 'quantity_litres', { required: true, customer })}
                  {input('Цена за литр, ₽', 'sale_price_per_litre', { required: true, customer })}
                  {input('Сумма перевозки, ₽', 'transport_amount', { customer })}
                  {select('Менеджер', 'manager_id', directories.managers, { required: true, customer })}
                </div>
                <div className="shipment-trip-delivery-fields"><h4>Доставка</h4><div className="shipment-field-grid">
                  <div className="form-field-wide">{location(customer)}</div>
                  {dateTimeInput('Плановая выгрузка', customer.fields.unloading_planned_at || '', value => updateCustomer(customer.key, 'unloading_planned_at', value))}
                  {dateTimeInput('Фактическая выгрузка', customer.fields.unloading_actual_at || '', value => updateCustomer(customer.key, 'unloading_actual_at', value))}
                  <label className="shipment-field form-field-wide"><span>Примечание к доставке</span><textarea rows={2} value={customer.fields.delivery_notes ?? ''} disabled={disabled} onChange={event => updateCustomer(customer.key, 'delivery_notes', event.target.value)}/></label>
                  <label className="trip-invoice-option"><input type="checkbox" checked={customer.fields.invoice_not_required === 'true'} disabled={disabled} onChange={event => updateCustomer(customer.key, 'invoice_not_required', String(event.target.checked))}/>Счёт не нужен</label>
                </div></div>
                <div className="shipment-calculation-strip shipment-trip-client-totals">{output('Тоннаж клиента, т', allocation?.tonnes[index], 6)}{output('Сумма клиента, ₽', litres && price ? litres.times(price).toFixed(2) : null)}{output('Прибыль, ₽', calculation?.fields.profit_source)}<span className="shipment-trip-auto">Тоннаж · автоматически</span></div>
                {calculation?.warnings.map(w => <p key={w} className="shipment-calculation-warning">{w}</p>)}
                <div className="trip-intermediate-stops"><strong>Остановки после доставки {index + 1}</strong><p className="shipment-editor-note">Для собственных нужд бензовоза. В ЭТрН не включаются.</p>
                  {stopsAfter(customer).map((stop, stopIndex) => <div className="shipment-field-grid" key={stop.id}>
                    <label className="shipment-field"><span>Название остановки {stopIndex + 1}</span><input value={stop.name} maxLength={200} disabled={disabled} onChange={event => changeStops(customer, stopsAfter(customer).map(item => item.id === stop.id ? { ...item, name: event.target.value } : item))}/></label>
                    <label className="shipment-field"><span>Адрес остановки {stopIndex + 1}</span><input value={stop.address} maxLength={500} disabled={disabled} onChange={event => changeStops(customer, stopsAfter(customer).map(item => item.id === stop.id ? { ...item, address: event.target.value } : item))}/></label>
                    <button type="button" className="button" disabled={disabled} onClick={() => changeStops(customer, stopsAfter(customer).filter(item => item.id !== stop.id))}>Удалить остановку {stopIndex + 1}</button>
                  </div>)}
                  <button type="button" className="button" disabled={disabled || stopsAfter(customer).length >= 10} onClick={() => changeStops(customer, [...stopsAfter(customer), { id: crypto.randomUUID(), name: '', address: '' }])}><Plus size={15}/>Добавить промежуточную остановку</button>
                </div>
              </fieldset>
            })}
            <button type="button" className="button shipment-trip-add" disabled={disabled || draft.customers.length >= 100} onClick={addCustomer}><Plus size={18}/>Добавить клиента</button>
            {draft.customers.some(customer => stopsAfter(customer).length > 0) && <label className="shipment-field"><span>Промежуточные остановки в заявке Saby</span><select value={fields.intermediate_stops_in_order || ''} disabled={disabled} onChange={event => update('intermediate_stops_in_order', event.target.value)}><option value="">Выберите перед отправкой</option><option value="true">Включать в заявку</option><option value="false">Только маршрут CRM</option></select></label>}
            <div className="shipment-trip-distribution"><div className="shipment-calculation-strip">{output('Литров по клиентам, л', totalLitres.toString(), 3)}{output('Масса груза, т', numericValue(fields.quantity_tonnes)?.toString(), 6)}{output('Дней с отгрузки', unpaidDays, 0)}</div><p>{allocation ? 'Масса груза клиента = масса груза рейса × литры клиента ÷ все литры.' : 'Заполните массу груза и литры каждого клиента — распределение рассчитается автоматически.'} Дни отображаются, пока есть неоплаченные отгрузки клиентов.</p></div>
          </section>

          <fieldset className="shipment-fieldset group-delivery"><legend>Водитель и автомобиль</legend><div className="shipment-field-grid">
            {select('Водитель', 'driver_id', directories.drivers.map(entry => ({ id: entry.id, name: entry.name, detail: [entry.phone, directories.vehicles.find(item => item.id === entry.vehicleId)?.name || directories.vehicles.find(item => item.id === entry.vehicleId)?.plate].filter(Boolean).join(' · ') })), { required: true })}
            {select('Автомобиль', 'vehicle_id', vehicleEntries, { required: true })}
          </div>
            {vehicle && <div className="shipment-trip-fleet"><div><p><span>Тип транспортного средства</span><strong>{vehicle.transportVehicleType || vehicle.vehicleType || 'Не указан в карточке автомобиля'}</strong></p><p><span>Марка и модель</span><strong>{[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || 'Не указаны в карточке автомобиля'}</strong></p><p><span>Грузоподъёмность</span><strong>{vehicle.payloadTonnes ? `${number(vehicle.payloadTonnes)} т` : 'Не указана в карточке автомобиля'}</strong></p></div></div>}
            {(driver || vehicle) && <div className="shipment-trip-fleet"><Truck size={20}/><div>{driver?.phone && <p><span>Телефон водителя</span><a href={`tel:${driver.phone.replace(/[^+\d]/g, '')}`}>{driver.phone}</a></p>}{vehicle && <p><span>Объём автомобиля</span><strong>{vehicle.capacityLitres == null ? 'Не указан' : `${number(vehicle.capacityLitres)} л`}</strong></p>}{!!vehicle?.compartmentsLitres?.length && <p><span>Разбивка по секциям</span><strong>{vehicle.compartmentsLitres.map(value => number(value)).join(' + ')} л</strong></p>}</div></div>}
            <p className="shipment-trip-field-note">При выборе водителя подставляется автомобиль из его карточки. При необходимости выберите другую машину из справочника.</p>
            {driver && !driverVehicleId(directories, driver.id) && <p className="shipment-editor-note">В карточке водителя не указан доступный автомобиль. Выберите машину из справочника.</p>}
            {overCapacity && <p className="shipment-calculation-warning" role="status">Литры клиентов превышают объём выбранного автомобиля на {number(totalLitres.minus(capacity!).toString(), 3)} л. Проверьте объём и автомобиль.</p>}
          </fieldset>

          <label className="shipment-field trip-notes"><span>Примечание к рейсу</span><textarea value={fields.trip_notes ?? ''} maxLength={4000} rows={3} disabled={disabled} onChange={event => update('trip_notes', event.target.value)}/></label>
          <details className="shipment-trip-extras"><summary><div><span>Дополнительные затраты</span><small>{numericValue(fields.additional_costs || '0')?.gt(0) ? `${number(numericValue(fields.additional_costs)!.toString(), 2)} ₽ на всю машину` : 'При необходимости'}</small></div><ChevronDown size={19}/></summary><div className="shipment-trip-extras-body">{input('Дополнительные затраты, ₽', 'additional_costs')}<p>Общие для всей машины. Распределяются между клиентами пропорционально литрам.</p></div></details>
        </>}
      </div>
      <footer className="shipment-editor-footer">{confirmClose ? <div className="shipment-discard" role="alert"><span>Есть несохранённые изменения.</span><button type="button" className="button" onClick={() => setConfirmClose(false)}>Продолжить</button><button type="button" className="button danger" onClick={onClose}>Закрыть без сохранения</button></div> : <><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button type="submit" className="button primary" disabled={saving || loading || conflict || !!loadError || !!tripId && !dirty}>{saving ? <LoaderCircle className="spin" size={17}/> : <Save size={17}/>} {uncertain ? 'Повторить сохранение' : tripMode ? 'Сохранить рейс' : 'Сохранить отгрузку'}</button></>}</footer>
    </form>
  </dialog>
}
