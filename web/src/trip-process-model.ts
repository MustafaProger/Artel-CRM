import type { TripExecution, TripExecutionEvent } from './trip-execution-model'

export interface SharedTripTimeline {
  id: string
  number?: number
  createdAt: string | null
  date: string | null
  vehicleId: string | null
  driverId: string | null
  stage: TripExecution['stage']
  loading: {
    address: string | null
    plannedAt: string | null
    actualAt: string | null
    arrivedAt: string | null
    departedAt: string | null
  }
  stops: SharedTripStop[]
  completedAt: string | null
}

export type SharedTripStop = {
  name: string
  address: string | null
} & ({
  kind: 'delivery'
  fromOwnRequest: boolean
  plannedAt: string | null
  actualAt: string | null
  event: Pick<TripExecutionEvent, 'at' | 'kind'> | null
} | { kind: 'intermediate' })
