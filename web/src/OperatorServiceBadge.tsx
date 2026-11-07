import { display } from './operator-ui-utils'
import './operator-operation-presentation.css'

export type OperatorServiceTone = 'lukoil' | 'yandex' | 'rosneft' | 'gpn' | 'nnk' | 'neutral'

const normalizeService = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '')
const serviceAliases: Record<Exclude<OperatorServiceTone, 'neutral'>, readonly string[]> = {
  lukoil: ['лукойл', 'лукоил', 'lukoil', 'lukoyl', 'licard'],
  yandex: ['яндекс', 'яндексgo', 'яндексго', 'яндексзаправки', 'yandex', 'yandexgo'],
  rosneft: ['роснефть', 'rosneft'],
  gpn: ['гпн', 'газпромнефть', 'gpn', 'gazpromneft'],
  nnk: ['ннк', 'nnk', 'независимаянефтегазоваякомпания'],
}

/** Classify the saved name first, retaining the original label and discount. */
export function operatorServiceTone(service: string, serviceId?: string): OperatorServiceTone {
  const name = normalizeService(service)
  for (const [tone, aliases] of Object.entries(serviceAliases)) {
    if (aliases.includes(name)) return tone as OperatorServiceTone
  }
  const id = normalizeService(serviceId ?? '').replace(/^operatorservice/, '')
  for (const [tone, aliases] of Object.entries(serviceAliases)) {
    if (aliases.includes(id)) return tone as OperatorServiceTone
  }
  return 'neutral'
}

export interface OperatorServiceBadgeProps {
  service: string
  serviceId?: string
  discountPercent?: string
  part?: 'name' | 'discount' | 'both'
}

export default function OperatorServiceBadge({ service, serviceId, discountPercent, part = 'both' }: OperatorServiceBadgeProps) {
  const tone = operatorServiceTone(service, serviceId)
  const discount = discountPercent === undefined || discountPercent === '' ? null : display(discountPercent)
  return <span className={`operator-service-badges operator-service-${tone}`}>
    {part !== 'discount' && <span className="operator-service-badge">{service || 'Сервис не указан'}</span>}
    {part !== 'name' && discount !== null && <span className="operator-service-badge operator-discount-badge" aria-label={`Скидка ${discount}%`}>{discount}%</span>}
  </span>
}
