import type { Shipment } from './model'

/** Stable legal-entity identities shared by shipments and saved bank connections. */
export const ourOrganizations = [
  { id: 'nk-artel', name: 'НК АРТЕЛЬ', connectionIds: ['sber-nk-artel', 'tbank-nk-artel'] },
  { id: 'artel', name: 'АРТЕЛЬ', connectionIds: ['sber-artel'] },
] as const

export type OurOrganizationId = typeof ourOrganizations[number]['id']
export function isOurOrganizationId(value: unknown): value is OurOrganizationId {
  return ourOrganizations.some(organization => organization.id === value)
}
/** Historical records without an explicit selection stay unassigned. */
export function shipmentOrganizationId(shipment: Pick<Shipment, 'fields'>): OurOrganizationId | null {
  return isOurOrganizationId(shipment.fields.organization_id) ? shipment.fields.organization_id : null
}
export function organizationForConnection(connectionId: string): OurOrganizationId | null {
  return ourOrganizations.find(organization => (organization.connectionIds as readonly string[]).includes(connectionId))?.id ?? null
}
export function organizationName(id: string | null | undefined): string | null {
  return ourOrganizations.find(organization => organization.id === id)?.name ?? null
}
