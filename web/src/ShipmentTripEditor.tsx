import { useEffect, useMemo, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { ChevronDown, LoaderCircle, Plus, Save, Trash2, Truck, X } from 'lucide-react'
import DirectorySelect, { type SelectEntry } from './DirectorySelect'
import type { ShipmentEditorProps } from './ShipmentEditor'
import { calculateShipment, daysSinceShipment, today, unpaidShipmentDays } from './shipment-calculations'
import { customerManagerId } from './customer-manager'
import { allocateTrip } from './trip-calculations'
import { number } from './utils'

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

export default function ShipmentTripEditor({ shipment, companies, directories, defaultPaymentForm = 'б/нал', onClose, onSaved }: ShipmentEditorProps) {
  const tripId = shipment?.fields.trip_id
  const dialog = useRef<HTMLDialogElement>(null)
  const errorElement = useRef<HTMLDivElement>(null)
  const pendingCustomerFocus = useRef<string | null>(null)
  const defaultPaymentId = directories.paymentForms.find(p => p.name === defaultPaymentForm)?.id ?? ''
  const newCustomer = (): CustomerDraft => ({
    key: crypto.randomUUID(),
    fields: { customer_id: '', payment_form_id: defaultPaymentId, quantity_litres: '', sale_price_per_litre: '', transport_amount: '0', unloading_address_id: '', manager_id: '' },
  })
  const [draft, setDraft] = useState<TripDraft>(() => ({
    fields: { date: today(), supplier_id: '', loading_address_id: '', purchase_price_unspecified_unit: '', quantity_tonnes: '', product_id: '', driver_id: '', vehicle_id: '', additional_costs: '0' },
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
  const disabled = saving || loading

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
  const companyEntries = companies.map(company => ({ id: company.id, name: company.name, detail: company.inn ? `ИНН ${company.inn}` : undefined }))
  const vehicleEntries = directories.vehicles.map(entry => ({ id: entry.id, name: entry.name || entry.plate, detail: [entry.name && entry.name !== entry.plate ? entry.plate : '', entry.capacityLitres ? `${number(entry.capacityLitres)} л` : ''].filter(Boolean).join(' · ') }))

  const changed = () => { setConfirmClose(false); setError('') }
  const update = (key: string, value: string) => {
    setDraft(previous => ({ ...previous, fields: { ...previous.fields, [key]: value, ...(key === 'supplier_id' ? { loading_address_id: '' } : key === 'driver_id' ? { vehicle_id: directories.drivers.find(entry => entry.id === value)?.vehicleId ?? '' } : {}) } }))
    changed()
  }
  const updateCustomer = (customerKey: string, key: string, value: string) => {
    setDraft(previous => ({ ...previous, customers: previous.customers.map(customer => customer.key !== customerKey ? customer : { ...customer, fields: { ...customer.fields, [key]: value, ...(key === 'customer_id' ? { unloading_address_id: '', manager_id: customerManagerId(directories, value) } : {}) } }) }))
    changed()
  }
  const addCustomer = () => {
    const customer = newCustomer()
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
  const close = () => { if (!saving) { if (dirty) setConfirmClose(true); else onClose() } }

  const validate = () => {
    if (!fields.date) return 'Укажите дату отгрузки.'
    if (!companies.some(company => company.id === fields.supplier_id)) return 'Выберите поставщика из списка.'
    if (!numericValue(fields.purchase_price_unspecified_unit)?.gt(0)) return 'Укажите цену поставщика за тонну больше нуля.'
    if (!numericValue(fields.quantity_tonnes)?.gt(0)) return 'Укажите тоннаж всей машины больше нуля.'
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
    if (disabled || loadError) return
    const validationError = validate()
    if (validationError) { setError(validationError); errorElement.current?.focus(); return }
    setError('')
    setSaving(true)
    const clean = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() || null]))
    const payload = {
      fields: clean({ ...fields, additional_costs: fields.additional_costs || '0' }),
      customers: draft.customers.map(customer => ({ ...(customer.id ? { id: customer.id } : {}), fields: clean({ ...customer.fields, transport_amount: customer.fields.transport_amount || '0' }) })),
      ...(tripId ? { versions } : {}),
    }
    try {
      const response = await fetch(tripId ? `/api/shipment-trips/${encodeURIComponent(tripId)}` : '/api/shipment-trips', { method: tripId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить отгрузку')
      onSaved(result.shipment ?? result.shipments[0])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
    finally { setSaving(false) }
  }

  const select = (label: string, key: string, entries: SelectEntry[], options: { required?: boolean; disabled?: boolean; customer?: CustomerDraft } = {}) => <DirectorySelect label={label} value={(options.customer?.fields ?? fields)[key] ?? ''} entries={entries} required={options.required} disabled={disabled || options.disabled} onChange={value => options.customer ? updateCustomer(options.customer.key, key, value) : update(key, value)}/>
  const input = (label: string, key: string, options: { required?: boolean; type?: string; customer?: CustomerDraft } = {}) => <label className="shipment-field"><span>{label}{options.required && ' *'}</span><input type={options.type ?? 'text'} inputMode={options.type === 'date' ? undefined : 'decimal'} autoFocus={key === 'date'} value={(options.customer?.fields ?? fields)[key] ?? ''} required={options.required} disabled={disabled} onChange={event => options.customer ? updateCustomer(options.customer.key, key, event.target.value) : update(key, event.target.value)}/></label>
  const output = (label: string, value: string | number | null | undefined, digits = 2) => <div className="shipment-calculated"><span>{label}</span><output aria-label={label}>{value == null || value === '' ? '—' : number(value, digits)}</output></div>

  return <dialog ref={dialog} className="shipment-editor shipment-trip-editor" aria-labelledby="shipment-trip-title" onCancel={event => { event.preventDefault(); close() }}>
    <form onSubmit={save} noValidate onKeyDown={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.getAttribute('role') !== 'combobox') {
        event.preventDefault()
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button[type="submit"]'))
        controls[controls.indexOf(event.target) + 1]?.focus()
      }
    }}>
      <header className="shipment-editor-heading"><div><span>{tripId ? 'РЕДАКТИРОВАНИЕ ОТГРУЗКИ' : 'НОВАЯ ОТГРУЗКА'}</span><h2 id="shipment-trip-title">{tripId ? 'Изменить отгрузку' : 'Добавить отгрузку'}</h2></div><button type="button" className="icon-button" aria-label="Закрыть редактор" disabled={saving} onClick={close}><X size={23}/></button></header>
      <div className="shipment-editor-body" aria-busy={loading || saving}>
        {loading ? <div className="shipment-trip-loading" role="status"><LoaderCircle className="spin" size={24}/><span>Загружаем отгрузку и всех её клиентов…</span></div> : loadError ? <div className="shipment-trip-loading"><p className="shipment-error" role="alert">{loadError}</p><button type="button" className="button" onClick={() => setReload(value => value + 1)}>Повторить загрузку</button></div> : <>
          <p className="shipment-editor-note shipment-trip-intro">Одна машина — одна отгрузка. Укажите общий тоннаж, затем литры и условия для каждого клиента.</p>
          {error && <div ref={errorElement} className="shipment-error" role="alert" tabIndex={-1}>{error}</div>}
          <fieldset className="shipment-fieldset group-purchase"><legend>Отгрузка и поставщик</legend><div className="shipment-field-grid">
            {input('Дата отгрузки', 'date', { type: 'date', required: true })}
            {select('Поставщик', 'supplier_id', companyEntries, { required: true })}
            {select('Место загрузки', 'loading_address_id', directories.addresses.filter(address => address.kind === 'loading' && address.companyId === fields.supplier_id), { disabled: !fields.supplier_id })}
            {input('Цена поставщика за тонну, ₽', 'purchase_price_unspecified_unit', { required: true })}
            {input('Тоннаж всей машины, т', 'quantity_tonnes', { required: true })}
            {select('Товар', 'product_id', directories.products, { required: true })}
          </div></fieldset>

          <section className="shipment-trip-customers" aria-labelledby="shipment-trip-customers-title"><div className="shipment-trip-section-heading"><div><h3 id="shipment-trip-customers-title">Клиенты машины</h3><p>Тоннаж каждого клиента рассчитывается пропорционально его литрам.</p></div><span className="shipment-trip-count">{draft.customers.length}</span></div>
            {draft.customers.map((customer, index) => {
              const litres = numericValue(customer.fields.quantity_litres)
              const price = numericValue(customer.fields.sale_price_per_litre)
              const calculation = allocation ? calculateShipment({ ...fields, ...customer.fields, payment_form: directories.paymentForms.find(p => p.id === customer.fields.payment_form_id)?.name ?? null, quantity_tonnes: allocation.tonnes[index], additional_costs: allocation.additionalCosts[index] }, { sale: 'litres', purchase: 'tonnes', profit: directories.defaults.profit, debtSign: 'paid-minus-sale' }) : null
              return <fieldset key={customer.key} className="shipment-fieldset group-sale shipment-trip-customer" data-testid="trip-customer" data-customer-key={customer.key}>
                <legend>Клиент {index + 1}</legend>
                {draft.customers.length > 1 && <div className="shipment-trip-customer-actions"><button type="button" className="button shipment-trip-remove" aria-label={`Удалить клиента ${index + 1}`} disabled={disabled} onClick={() => removeCustomer(customer.key)}><Trash2 size={15}/>Удалить клиента {index + 1}</button></div>}
                <div className="shipment-field-grid">
                  {select('Клиент', 'customer_id', companyEntries, { required: true, customer })}
                  {select('Форма оплаты', 'payment_form_id', directories.paymentForms, { required: true, customer })}
                  {input('Количество литров, л', 'quantity_litres', { required: true, customer })}
                  {input('Цена за литр, ₽', 'sale_price_per_litre', { required: true, customer })}
                  {input('Сумма перевозки, ₽', 'transport_amount', { customer })}
                  {select('Место выгрузки', 'unloading_address_id', directories.addresses.filter(address => address.kind === 'delivery' && address.companyId === customer.fields.customer_id), { disabled: !customer.fields.customer_id, customer })}
                  {select('Менеджер', 'manager_id', directories.managers, { required: true, customer })}
                </div>
                <div className="shipment-calculation-strip shipment-trip-client-totals">{output('Тоннаж клиента, т', allocation?.tonnes[index], 6)}{output('Сумма клиента, ₽', litres && price ? litres.times(price).toFixed(2) : null)}{output('Прибыль, ₽', calculation?.fields.profit_source)}<span className="shipment-trip-auto">Тоннаж · автоматически</span></div>
                {calculation?.warnings.map(w => <p key={w} className="shipment-calculation-warning">{w}</p>)}
              </fieldset>
            })}
            <button type="button" className="button shipment-trip-add" disabled={disabled || draft.customers.length >= 100} onClick={addCustomer}><Plus size={18}/>Добавить клиента</button>
            <div className="shipment-trip-distribution"><div className="shipment-calculation-strip">{output('Литров по клиентам, л', totalLitres.toString(), 3)}{output('Тоннаж машины, т', numericValue(fields.quantity_tonnes)?.toString(), 6)}{output('Дней с отгрузки', unpaidDays, 0)}</div><p>{allocation ? 'Тоннаж клиента = тоннаж машины × литры клиента ÷ все литры.' : 'Заполните тоннаж машины и литры каждого клиента — распределение рассчитается автоматически.'} Дни отображаются, пока есть неоплаченные отгрузки клиентов.</p></div>
          </section>

          <fieldset className="shipment-fieldset group-delivery"><legend>Перевозчик и автомобиль</legend><div className="shipment-field-grid">
            {select('Перевозчик / водитель', 'driver_id', directories.drivers.map(entry => ({ id: entry.id, name: entry.name, detail: [entry.phone, directories.vehicles.find(item => item.id === entry.vehicleId)?.name || directories.vehicles.find(item => item.id === entry.vehicleId)?.plate].filter(Boolean).join(' · ') })), { required: true })}
            {select('Автомобиль', 'vehicle_id', vehicleEntries, { required: true })}
          </div>
            {(driver || vehicle) && <div className="shipment-trip-fleet"><Truck size={20}/><div>{driver?.phone && <p><span>Телефон водителя</span><a href={`tel:${driver.phone.replace(/[^+\d]/g, '')}`}>{driver.phone}</a></p>}{vehicle && <p><span>Объём автомобиля</span><strong>{vehicle.capacityLitres == null ? 'Не указан' : `${number(vehicle.capacityLitres)} л`}</strong></p>}{!!vehicle?.compartmentsLitres?.length && <p><span>Разбивка по секциям</span><strong>{vehicle.compartmentsLitres.map(value => number(value)).join(' + ')} л</strong></p>}</div></div>}
            <p className="shipment-trip-field-note">При выборе водителя подставляется его автомобиль. При необходимости выберите другой.</p>
            {overCapacity && <p className="shipment-calculation-warning" role="status">Литры клиентов превышают объём выбранного автомобиля на {number(totalLitres.minus(capacity!).toString(), 3)} л. Проверьте объём и автомобиль.</p>}
          </fieldset>

          <details className="shipment-trip-extras"><summary><div><span>Дополнительные затраты</span><small>{numericValue(fields.additional_costs || '0')?.gt(0) ? `${number(numericValue(fields.additional_costs)!.toString(), 2)} ₽ на всю машину` : 'При необходимости'}</small></div><ChevronDown size={19}/></summary><div className="shipment-trip-extras-body">{input('Дополнительные затраты, ₽', 'additional_costs')}<p>Общие для всей машины. Распределяются между клиентами пропорционально литрам.</p></div></details>
        </>}
      </div>
      <footer className="shipment-editor-footer">{confirmClose ? <div className="shipment-discard" role="alert"><span>Есть несохранённые изменения.</span><button type="button" className="button" onClick={() => setConfirmClose(false)}>Продолжить</button><button type="button" className="button danger" onClick={onClose}>Закрыть без сохранения</button></div> : <><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button type="submit" className="button primary" disabled={disabled || !!loadError || !!tripId && !dirty}>{saving ? <LoaderCircle className="spin" size={17}/> : <Save size={17}/>}Сохранить отгрузку</button></>}</footer>
    </form>
  </dialog>
}
