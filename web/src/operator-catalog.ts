import type { Directories, NamedEntry, OperatorService } from './model'

const defaultServices: readonly OperatorService[] = [
  { id: 'operator-service-rosneft', name: 'Роснефть', discountPercent: '10' },
  { id: 'operator-service-lukoil', name: 'Лукойл', discountPercent: '10' },
  { id: 'operator-service-gpn', name: 'ГПН', discountPercent: '10' },
  { id: 'operator-service-yandex', name: 'Яндекс', discountPercent: '10' },
  { id: 'operator-service-nnk', name: 'ННК', discountPercent: '10' },
]

/** Defaults are a read projection, never a migration or replacement of a saved list. */
export function readOperatorCatalog(directories: Pick<Directories, 'operatorGroups' | 'operatorServices'>): { groups: NamedEntry[]; services: OperatorService[] } {
  return {
    groups: (directories.operatorGroups ?? []).map(row => ({ ...row })),
    services: (directories.operatorServices === undefined ? defaultServices : directories.operatorServices).map(row => ({ ...row })),
  }
}

/** The first saved rate is the known baseline; earlier, unrecorded edits cannot be reconstructed. */
export function operatorDiscountAt(service: OperatorService, date: string): string {
  const history = service.discountHistory;
  if (!history?.length) return service.discountPercent;
  return [...history].reverse().find(rate => rate.effectiveFrom <= date)?.discountPercent ?? history[0].discountPercent;
}
export const operatorCatalogDate = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
