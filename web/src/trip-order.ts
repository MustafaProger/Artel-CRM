type TripChronology = {
  id: string
  createdAt?: string | null
  date?: string | null
  fields?: Record<string, string | null>
}

const timestamp = (value?: string | null) => {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** Adding a delivery or editing a plan must not make an existing trip new. */
export function tripCreatedAt(rows: readonly { createdAt?: string | null }[]): string | null {
  let earliest: string | null = null
  let earliestTime = Infinity
  for (const row of rows) {
    const time = timestamp(row.createdAt)
    if (time !== null && time < earliestTime) { earliest = row.createdAt!; earliestTime = time }
  }
  return earliest
}

/** Creation order first; historical trips without timestamps keep a stable date/id order. */
export function compareTripsNewestFirst(a: TripChronology, b: TripChronology): number {
  const createdA = timestamp(a.createdAt), createdB = timestamp(b.createdAt)
  if (createdA !== createdB) {
    if (createdA === null) return 1
    if (createdB === null) return -1
    return createdB - createdA
  }
  return (b.date ?? b.fields?.date ?? '').localeCompare(a.date ?? a.fields?.date ?? '') || a.id.localeCompare(b.id)
}
