import OperatorServiceBadge from './OperatorServiceBadge'
import { operatorServiceColors, operatorServiceBackground } from './operator-service-presentation'
export default function OperatorServiceColorPicker({ name, id, color, onChange, disabled }: { name: string; id?: string; color?: string; onChange: (color: string) => void; disabled: boolean }) {
  const selected = color ?? operatorServiceBackground(name, id)
  return <div className="shipment-field operator-color-picker"><span>Цвет фона</span>
    <div className="operator-color-options" role="group" aria-label="Цвет фона сервиса">{operatorServiceColors.map((value, i) => <button key={value} type="button" disabled={disabled} aria-label={['Розовый','Жёлтый','Тёмный','Голубой','Зелёный','Серый'][i]} aria-pressed={selected === value} style={{backgroundColor:value}} onClick={() => onChange(value)}/>)}
    <label>Свой цвет<input type="color" aria-label="Свой цвет фона" disabled={disabled} value={selected} onChange={event => onChange(event.target.value)}/></label></div>
    <OperatorServiceBadge service={name || 'Название сервиса'} backgroundColor={selected} part="name"/>
  </div>
}
