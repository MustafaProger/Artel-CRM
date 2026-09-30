export interface TripIntermediateStop { id: string; name: string; address: string }

/** Stops belong to the preceding delivery, so equal customers never merge routes. */
export function readIntermediateStops(value: string | null | undefined): TripIntermediateStop[] {
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length > 10) throw new Error('После доставки можно указать до 10 промежуточных остановок.')
  const ids = new Set<string>()
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Проверьте промежуточные остановки.')
    const row = item as Record<string, unknown>
    if (Object.keys(row).some(key => !['id', 'name', 'address'].includes(key)) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || ids.has(row.id)) throw new Error('Проверьте идентификаторы промежуточных остановок.')
    ids.add(row.id)
    for (const [key, limit] of [['name', 200], ['address', 500]] as const) {
      if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limit || [...row[key]].some(character => character.charCodeAt(0) < 32)) throw new Error('Укажите название и адрес каждой промежуточной остановки.')
    }
    return { id: row.id, name: (row.name as string).trim(), address: (row.address as string).trim() }
  })
}
