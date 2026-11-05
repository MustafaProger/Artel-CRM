import { ChevronDown } from 'lucide-react'
import type { Vehicle } from './model'
import type { TripTransportState } from './trip-transport-draft'
import { number } from './utils'
import './trip-transport-price.css'

export function TransportSectionAssignment({ vehicle, state, disabled, customerNumber, onChange }: {
  vehicle?: Vehicle
  state: TripTransportState
  disabled: boolean
  customerNumber: number
  onChange: (indexes: number[]) => void
}) {
  return <fieldset className="trip-transport-sections form-field-wide">
    <legend>Секции для клиента {customerNumber}</legend>
    {vehicle?.compartmentsLitres?.length ? <div className="trip-transport-section-options">{vehicle.compartmentsLitres.map((litres, index) => <label key={index}>
      <input type="checkbox" aria-label={`Секция ${index + 1} для клиента ${customerNumber}`} checked={state.indexes.includes(index)} disabled={disabled} onChange={event => onChange((event.target.checked ? [...state.indexes, index] : state.indexes.filter(value => value !== index)).sort((a, b) => a - b))}/>
      <span><strong>Секция {index + 1}</strong><span>{number(litres, 3)} л · {vehicle.compartmentDeparturePricesRub?.[index] === undefined ? 'тариф не указан' : `${number(vehicle.compartmentDeparturePricesRub[index], 2)} ₽`}</span></span>
    </label>)}</div> : <p>Выберите автомобиль с секциями, чтобы назначить их этой доставке.</p>}
    {state.frozen && <p>Здесь показаны текущие тарифы секций. Сохранённые ставки рейса — в расчёте под суммой.</p>}
  </fieldset>
}

export function TransportAmountField({ state, disabled, expanded, panelId, notice, onToggle, onAmount, onAutomatic, onManual }: {
  state: TripTransportState
  disabled: boolean
  expanded: boolean
  panelId: string
  notice?: string
  onToggle: () => void
  onAmount: (amount: string) => void
  onAutomatic: () => void
  onManual: () => void
}) {
  return <div className="trip-transport-amount">
    <label className="shipment-field"><span>Сумма перевозки, ₽</span><input aria-describedby={`${panelId}-status`} inputMode="decimal" value={state.fields.transport_amount ?? ''} placeholder={state.automatic ? 'Расчёт не завершён' : 'Введите сумму'} disabled={disabled} onChange={event => onAmount(event.target.value)}/></label>
    <div className="trip-transport-actions">
      <button type="button" className="trip-text-button trip-transport-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}><ChevronDown size={14} aria-hidden="true"/>{expanded ? 'Скрыть расчёт' : 'Показать расчёт'}</button>
      <button type="button" className="trip-text-button" disabled={disabled} onClick={state.automatic && !state.frozen ? onManual : onAutomatic}>{state.automatic ? state.frozen ? 'Пересчитать по текущим тарифам' : 'Ввести вручную' : 'Рассчитать автоматически'}</button>
    </div>
    <p id={`${panelId}-status`} className={`trip-transport-status${state.automatic && state.errors.length ? ' incomplete' : ''}`} role="status">{notice || (state.automatic ? state.errors.length ? 'Автоматический расчёт неполон. Откройте расчёт, чтобы проверить исходные данные, или введите сумму вручную.' : state.frozen ? 'Сохранённая сумма и тарифы рейса.' : 'Сумма рассчитана автоматически. Её можно изменить вручную.' : 'Сумма введена вручную и не пересчитывается автоматически.')}</p>
  </div>
}

export function TransportPriceBreakdown({ state, expanded, panelId }: { state: TripTransportState; expanded: boolean; panelId: string }) {
  const snapshot = state.snapshot
  return <div id={panelId} className={`trip-transport-breakdown${expanded ? ' is-open' : ''}`} aria-hidden={!expanded}>
    <div className="trip-transport-breakdown-clip"><div className="trip-transport-breakdown-body">
      {state.automatic && state.errors.length > 0 && <ul className="trip-transport-missing">{state.errors.map(error => <li key={error}>{error}</li>)}</ul>}
      {snapshot ? <>
        <p className="trip-transport-route">{snapshot.vehicleLabel} · {snapshot.oilDepotLabel} → {snapshot.addressLabel}</p>
        <dl className="trip-transport-calculation">
          {snapshot.sections.map(section => <div key={section.index}><dt>Секция {section.index + 1} · {number(section.litres, 3)} л</dt><dd>{number(section.priceRub, 2)} ₽</dd></div>)}
          <div><dt>Выезд выбранных секций</dt><dd>{number(snapshot.sectionsTotalRub, 2)} ₽</dd></div>
          <div><dt>{number(snapshot.distanceKm, 3)} км × {number(snapshot.ratePerKmRub, 2)} ₽/км</dt><dd>{number(snapshot.distanceTotalRub, 2)} ₽</dd></div>
          <div><dt>Доплата за клиента</dt><dd>{number(snapshot.customerSurchargeRub, 2)} ₽</dd></div>
          <div className="trip-transport-subtotal"><dt>До округления</dt><dd>{number(snapshot.subtotalRub, 2)} ₽</dd></div>
          <div><dt>{snapshot.rounding === 'ceil100' ? 'Округление вверх до 100 ₽' : 'Округление до ближайших 100 ₽'}</dt><dd>{Number(snapshot.roundingAdjustmentRub) > 0 ? '+' : ''}{number(snapshot.roundingAdjustmentRub, 2)} ₽</dd></div>
          <div className="trip-transport-total"><dt>Итого</dt><dd>{number(snapshot.totalRub, 2)} ₽</dd></div>
        </dl>
        <p className="trip-transport-rounding-note">{snapshot.rounding === 'nearest100' ? 'До ближайших 100 ₽, половина вверх.' : 'Вверх до 100 ₽.'} Округляется только итог этой доставки.</p>
      </> : !state.automatic ? <p>Для ручной суммы расшифровка не сохранена. Чтобы рассчитать её по секциям, расстоянию и общей ставке, нажмите «Рассчитать автоматически».</p> : <p>Стоимость выбранных секций + расстояние от нефтебазы × ставка за километр + доплата за клиента. Пропущенные значения не заменяются нулями.</p>}
    </div></div>
  </div>
}
