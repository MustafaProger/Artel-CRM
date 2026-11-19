import type { Directories } from './model'
import type { TripRequest } from './trip-request-model'
import { mapLink } from './map-link'
import { tripRequestMapCoordinates } from './trip-request-map-coordinates'
import { requestDateLabel } from './trip-request-schedule'
import { number } from './utils'

export function tripRequestCopyText(request: TripRequest, addresses: Directories['addresses']): string {
  const place = addresses.find(row => row.id === request.addressId && row.companyId === request.companyId && row.kind === 'delivery')
  const point = tripRequestMapCoordinates(request, addresses)
  const link = mapLink({ ...request, ...(point?.status === 'found' ? point : {}) })
  const contacts = [{ name: place?.receiverName, phone: place?.receiverPhone }, ...(place?.additionalReceivers ?? [])]
  return [
    request.executionDate ? requestDateLabel(request.executionDate) : 'Дата не указана',
    request.companyName,
    `${number(request.quantityLitres, 6)} л | ${request.salePricePerLitre?.trim() ? `${number(request.salePricePerLitre, 6)} ₽/л` : 'Цена не указана'}`,
    request.address.trim() || request.addressName.trim() || 'Адрес не указан',
    link?.href ?? 'Ссылка на Яндекс.Карты не указана',
    contacts.map(contact => `${contact.name?.trim() || 'Приёмщик не указан'} | ${contact.phone?.trim() || 'Телефон не указан'}`).join('\n'),
    request.comment.trim() || 'Комментарий не указан',
  ].join('\n')
}
