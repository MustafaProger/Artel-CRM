import type { ReactNode } from 'react'
import type { EtrnParty, SabyConsignmentProfile } from './etrn-model'

const emptyParty = (): EtrnParty => ({ name: '', inn: '', kpp: '', address: '', phone: '', edoId: '' })
export function emptyEtrnProfile(): SabyConsignmentProfile {
  return {
    confirmed: false, consignorPhone: '', carrierPhone: '', consignorIsForwarder: '', order: { number: '', date: '' },
    signer: { surname: '', name: '', patronymic: '', position: '', status: '' }, recipient: emptyParty(),
    cargo: { name: '', condition: '', packagingCode: '', packingMethod: '', packageCount: '', marking: '', massMethod: '' },
    deliveryMassTonnes: '', vehicle: { type: '', brand: '', payloadTonnes: '', capacityCubicMetres: '', ownershipType: '' },
    driver: { surname: '', name: '', patronymic: '' }, loading: { arrivedAt: '', departedAt: '' },
    loadingActor: { sameAsConsignor: null, party: emptyParty() }, infrastructureOwner: { sameAsConsignor: null, party: emptyParty() },
    instructions: { regulatory: '', redirectionParty: '', redirectionMethod: '', redirectionPhone: '', transshipmentForbidden: '' },
  }
}

type Option = [string, string]
type FormField = { path: string; label: string; hint?: string; type?: 'date' | 'datetime-local' | 'tel'; numeric?: boolean; options?: Option[]; wide?: boolean }

function getValue(profile: SabyConsignmentProfile, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, profile)
}
function changeValue(profile: SabyConsignmentProfile, path: string, value: unknown): SabyConsignmentProfile {
  const next = structuredClone(profile)
  const keys = path.split('.')
  let object = next as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    if (!object[key] || typeof object[key] !== 'object') object[key] = {}
    object = object[key] as Record<string, unknown>
  }
  object[keys.at(-1)!] = value
  next.confirmed = path === 'confirmed' ? !!value : false
  return next
}

const partyFields = (path: string, edo = false): FormField[] => [
  { path: `${path}.name`, label: 'Наименование', wide: true },
  { path: `${path}.inn`, label: 'ИНН', numeric: true }, { path: `${path}.kpp`, label: 'КПП', numeric: true },
  { path: `${path}.address`, label: 'Адрес организации', wide: true }, { path: `${path}.phone`, label: 'Телефон', type: 'tel' },
  ...(edo ? [{ path: `${path}.edoId`, label: 'Идентификатор участника ЭДО, если известен', hint: 'Из карточки участника в Saby.', wide: true }] : []),
]
const nameFields = (path: string): FormField[] => [{ path: `${path}.surname`, label: 'Фамилия' }, { path: `${path}.name`, label: 'Имя' }, { path: `${path}.patronymic`, label: 'Отчество, если есть' }]

/** Human-readable, per-delivery facts. No sample-derived values or signature material. */
export default function EtrnProfileForm({ value, disabled, onChange }: { value: SabyConsignmentProfile; disabled: boolean; onChange: (value: SabyConsignmentProfile) => void }) {
  const change = (path: string, next: unknown) => onChange(changeValue(value, path, next))
  const field = ({ path, label, hint, type, numeric, options, wide }: FormField) => {
    const raw = getValue(value, path)
    const current = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : ''
    return <label key={path} className={`etrn-field${wide ? ' etrn-field-wide' : ''}`}><span>{label}</span>
      {options ? <select aria-label={label} value={current} onChange={event => change(path, event.target.value)}><option value="">Не выбрано</option>{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select>
        : <input aria-label={label} type={type ?? 'text'} inputMode={numeric ? 'decimal' : undefined} maxLength={2000} value={current} onChange={event => change(path, path.endsWith('.issuerInns') ? event.target.value.split(/[,;]/).map(item => item.trim()) : event.target.value)} onBlur={event => {
          if (numeric && event.target.value.includes(',')) change(path, event.target.value.replace(',', '.'))
          if (path.endsWith('.issuerInns') && Array.isArray(raw) && raw.some(item => !item)) change(path, raw.filter(Boolean))
        }} />}
      {hint && <small>{hint}</small>}
    </label>
  }
  const group = (title: string, fields: FormField[], extra?: ReactNode) => <fieldset className="etrn-form-group"><legend>{title}</legend><div className="etrn-form-grid">{fields.map(field)}{extra}</div></fieldset>
  const loadingParty = (path: 'loadingActor' | 'infrastructureOwner', title: string) => <fieldset className="etrn-form-group"><legend>{title}</legend>
    <label className="etrn-field"><span>Совпадает с грузоотправителем</span><select aria-label="Совпадает с грузоотправителем" value={value[path].sameAsConsignor === null ? '' : value[path].sameAsConsignor ? 'yes' : 'no'} onChange={event => change(path, { sameAsConsignor: event.target.value === '' ? null : event.target.value === 'yes', party: value[path].party ?? emptyParty() })}><option value="">Не подтверждено</option><option value="yes">Да</option><option value="no">Нет, другая организация</option></select></label>
    {value[path].sameAsConsignor === false && <div className="etrn-form-grid">{partyFields(`${path}.party`).map(field)}</div>}
  </fieldset>
  return <fieldset className="etrn-profile-form" disabled={disabled}>
    {group('Заявка и роль грузоотправителя', [
      { path: 'order.number', label: 'Номер заявки на перевозку' }, { path: 'order.date', label: 'Дата заявки', type: 'date' },
      { path: 'consignorIsForwarder', label: 'Роль грузоотправителя', options: [['0', 'Грузоотправитель'], ['1', 'Экспедитор']], wide: true },
      { path: 'consignorPhone', label: 'Телефон грузоотправителя', type: 'tel' }, { path: 'carrierPhone', label: 'Телефон перевозчика', type: 'tel' },
    ])}
    {value.consignorIsForwarder === '1' && group('Заказчик перевозки при экспедировании', partyFields('transportCustomer'))}
    {value.consignorIsForwarder === '1' && group('Договор с заказчиком перевозки', [
      { path: 'transportCustomerContract.name', label: 'Наименование договора' }, { path: 'transportCustomerContract.number', label: 'Номер договора' },
      { path: 'transportCustomerContract.date', label: 'Дата договора', type: 'date' }, { path: 'transportCustomerContract.issuerInns', label: 'ИНН составителей договора через запятую' },
    ])}
    {group('Грузополучатель', partyFields('recipient', true))}
    {group('Груз этой доставки', [
      { path: 'cargo.name', label: 'Транспортное наименование груза', wide: true }, { path: 'cargo.condition', label: 'Состояние груза' },
      { path: 'cargo.packagingCode', label: 'Код вида тары' }, { path: 'cargo.packingMethod', label: 'Способ упаковки' },
      { path: 'cargo.packageCount', label: 'Количество грузовых мест', numeric: true }, { path: 'cargo.marking', label: 'Маркировка' },
      { path: 'cargo.massMethod', label: 'Способ определения массы', options: [['01', 'Взвешивание по общей массе'], ['02', 'Поосное взвешивание'], ['03', 'Расчётная масса']] },
      { path: 'deliveryMassTonnes', label: 'Фактическая масса этой доставки, т', numeric: true, hint: 'Подтвердите по документам. Расчётное распределение общего тоннажа рейса не подтверждает фактическую массу.' },
    ], <label className="etrn-field etrn-field-wide"><span>Опасный груз</span><select aria-label="Опасный груз" value={value.cargo.dangerousGoods === undefined ? '' : value.cargo.dangerousGoods === null ? 'no' : 'yes'} onChange={event => change('cargo.dangerousGoods', event.target.value === '' ? undefined : event.target.value === 'no' ? null : { unNumber: '', shippingName: '', class: '', classificationCode: '', packingGroup: '', hazardSign: '', tunnelCode: '' })}><option value="">Не подтверждено</option><option value="no">Не является опасным грузом</option><option value="yes">Опасный груз — заполнить классификацию</option></select></label>)}
    {value.cargo.dangerousGoods && group('Классификация опасного груза', [
      { path: 'cargo.dangerousGoods.unNumber', label: 'Номер ООН' }, { path: 'cargo.dangerousGoods.shippingName', label: 'Надлежащее отгрузочное наименование', wide: true },
      { path: 'cargo.dangerousGoods.class', label: 'Класс опасности' }, { path: 'cargo.dangerousGoods.classificationCode', label: 'Классификационный код' },
      { path: 'cargo.dangerousGoods.packingGroup', label: 'Группа упаковки' }, { path: 'cargo.dangerousGoods.hazardSign', label: 'Знаки опасности' }, { path: 'cargo.dangerousGoods.tunnelCode', label: 'Код ограничения проезда через тоннели' },
    ])}
    <details className="etrn-optional"><summary>Габариты грузового места, если применимо</summary>{group('Габариты, м', [
      { path: 'cargo.dimensions.heightMetres', label: 'Высота', numeric: true }, { path: 'cargo.dimensions.lengthMetres', label: 'Длина', numeric: true }, { path: 'cargo.dimensions.widthMetres', label: 'Ширина', numeric: true },
    ])}<button type="button" className="trip-text-button" onClick={() => change('cargo.dimensions', undefined)}>Не указывать габариты</button></details>
    {group('Автомобиль', [
      { path: 'vehicle.type', label: 'Тип транспортного средства' }, { path: 'vehicle.brand', label: 'Марка' },
      { path: 'vehicle.payloadTonnes', label: 'Грузоподъёмность, т', numeric: true, hint: 'По документам автомобиля; полная масса сюда не подходит.' }, { path: 'vehicle.capacityCubicMetres', label: 'Вместимость, м³', numeric: true },
      { path: 'vehicle.ownershipType', label: 'Основание владения автомобилем', options: [['1', 'Собственность'], ['2', 'Совместная собственность супругов'], ['3', 'Аренда'], ['4', 'Лизинг'], ['5', 'Безвозмездное пользование']] },
    ])}
    {['3', '4', '5'].includes(value.vehicle.ownershipType) && group('Документ на право пользования автомобилем', [
      { path: 'vehicle.ownershipDocument.name', label: 'Наименование документа' }, { path: 'vehicle.ownershipDocument.number', label: 'Номер документа' },
      { path: 'vehicle.ownershipDocument.date', label: 'Дата документа', type: 'date' }, { path: 'vehicle.ownershipDocument.issuerInns', label: 'ИНН составителей через запятую' },
    ])}
    {group('Водитель выбранного рейса', nameFields('driver'))}
    {group('Фактическая погрузка · московское время', [
      { path: 'loading.arrivedAt', label: 'Прибытие под погрузку', type: 'datetime-local' }, { path: 'loading.departedAt', label: 'Убытие после погрузки', type: 'datetime-local' },
    ])}
    {loadingParty('loadingActor', 'Лицо, осуществляющее погрузку')}
    {loadingParty('infrastructureOwner', 'Владелец объекта погрузки')}
    {group('Указания по перевозке', [
      { path: 'instructions.regulatory', label: 'Нормативные требования к перевозке', wide: true },
      { path: 'instructions.redirectionParty', label: 'Лицо, дающее указания о переадресовке' }, { path: 'instructions.redirectionMethod', label: 'Способ получения указаний о переадресовке' },
      { path: 'instructions.redirectionPhone', label: 'Телефон для переадресовки', type: 'tel' },
      { path: 'instructions.transshipmentForbidden', label: 'Перегрузка', options: [['0', 'Разрешена'], ['1', 'Запрещена']] },
    ])}
    {group('Подписант грузоотправителя', [
      ...nameFields('signer'), { path: 'signer.position', label: 'Должность' },
      { path: 'signer.status', label: 'Основание полномочий подписанта', options: [['1', 'Грузоотправитель без доверенности'], ['2', 'От грузоотправителя по электронной доверенности'], ['3', 'От грузоотправителя по бумажной доверенности'], ['4', 'Лицо, осуществившее погрузку, без доверенности'], ['5', 'От лица, осуществившего погрузку, по электронной доверенности'], ['6', 'От лица, осуществившего погрузку, по бумажной доверенности']], wide: true },
    ])}
    {['2', '5'].includes(value.signer.status) && group('Электронная доверенность подписанта', [
      { path: 'signer.powerOfAttorney.number', label: 'Номер доверенности' }, { path: 'signer.powerOfAttorney.date', label: 'Дата доверенности', type: 'date' }, { path: 'signer.powerOfAttorney.id', label: 'Идентификатор доверенности' },
    ])}
    <label className="etrn-confirm"><input type="checkbox" checked={value.confirmed} onChange={event => change('confirmed', event.target.checked)} /><span>Данные проверены для этой доставки: участники, груз, автомобиль, фактическая погрузка и полномочия подписанта.</span></label>
  </fieldset>
}
