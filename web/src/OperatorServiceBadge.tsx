import { display } from './operator-ui-utils'
import './operator-operation-presentation.css'

import { createContext, useContext, type CSSProperties } from 'react'
import type { OperatorService } from './model'
import { operatorServiceTone, operatorServiceInk } from './operator-service-presentation'
export { operatorServiceTone } from './operator-service-presentation'
export const OperatorServicesContext = createContext<OperatorService[]>([])

export interface OperatorServiceBadgeProps {
  service: string
  serviceId?: string
  discountPercent?: string
  backgroundColor?: string
  part?: 'name' | 'discount' | 'both'
}

export default function OperatorServiceBadge({ service, serviceId, discountPercent, backgroundColor, part = 'both' }: OperatorServiceBadgeProps) {
  const services = useContext(OperatorServicesContext)
  const current = serviceId ? services.find(item => item.id === serviceId) : undefined
  const name = current?.name ?? service
  const background = backgroundColor ?? current?.backgroundColor
  const style = background ? { '--service-fill': background, '--service-ink': operatorServiceInk(background) } as CSSProperties : undefined
  const tone = operatorServiceTone(name, serviceId)
  const discount = discountPercent === undefined || discountPercent === '' ? null : display(discountPercent)
  return <span style={style} className={`operator-service-badges operator-service-${tone}`}>
    {part !== 'discount' && <span className="operator-service-badge">{name || 'Сервис не указан'}</span>}
    {part !== 'name' && discount !== null && <span className="operator-service-badge operator-discount-badge" aria-label={`Скидка ${discount}%`}>{discount}%</span>}
  </span>
}
