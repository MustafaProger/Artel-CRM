export type TripExecutionEvent = { at: string; by: string; name: string; role: 'driver' | 'logistics'; kind?: 'arrival' }
export type TripExecution = {
  version: number
  stage: 'planned' | 'loading' | 'enroute' | 'delivering' | 'delivered' | 'completed' | 'conflict'
  arrivedAt: string | null; departedAt: string | null
  deliveries: Record<string, TripExecutionEvent>
  completed: TripExecutionEvent | null
}
export const executionStageLabel: Record<TripExecution['stage'], string> = {
  planned: 'Ждёт погрузки', loading: 'На погрузке', enroute: 'В пути',
  delivering: 'Доставляет', delivered: 'Все доставки отмечены', completed: 'Завершён', conflict: 'Требуется сверка состава',
}

export const executionStageHint: Record<TripExecution['stage'], string> = {
  planned: 'Водитель ещё не отметил прибытие на погрузку.',
  loading: 'Водитель прибыл. Ждём массу груза и отметку об убытии.',
  enroute: 'Водитель убыл с погрузки. Ни одна доставка пока не подтверждена.',
  delivering: 'Часть доставок подтверждена. Ждём остальные точки маршрута.',
  delivered: 'Все доставки отмечены. Обновите данные для проверки завершения.',
  completed: 'Все доставки подтверждены. Рейс завершён и находится в архиве водителя.',
  conflict: 'Состав рейса изменился после отметок. Логисту нужно сверить доставки.',
}
