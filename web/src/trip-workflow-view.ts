import type { TripSabyResponse } from './trip-saby-model'

export const exchangeStageLabels: Record<string, string> = {
  sender_action_required: 'АРТЕЛЬ · подпись и отправка',
  sending_to_carrier: 'Заявка передаётся в НК АРТЕЛЬ',
  signature_pending: 'Ожидаем электронную подпись',
  carrier_details_required: 'НК АРТЕЛЬ · водитель и машина',
  carrier_action_required: 'НК АРТЕЛЬ · подпись и утверждение',
  carrier_confirmation_pending: 'Ожидаем подтверждение Saby',
  carrier_confirmed: 'НК АРТЕЛЬ подтвердило заявку',
  rejected: 'НК АРТЕЛЬ отклонило заявку',
  operator_error: 'Ошибка обработки Saby',
  cancelled: 'Заявка аннулирована',
  unknown: 'Состояние уточняется',
}

export function workflowView(result: TripSabyResponse) {
  const stage = result.order?.exchangeStage
  if (result.phase === 'unknown') return { title: 'Нужна сверка с Saby', text: 'Ответ не подтверждён. CRM проверяет сохранённый документ; повторная заявка не создаётся.', step: 1 }
  if (result.phase === 'error') {
    const terminalStage = stage === 'rejected' || stage === 'operator_error' || stage === 'cancelled'
    const afterConfirmation = stage === 'carrier_confirmed' || result.carrierConfirmed
    return {
      title: terminalStage ? exchangeStageLabels[stage] : afterConfirmation ? 'Создание ЭТрН приостановлено' : 'Обмен приостановлен',
      text: 'Проверьте сообщение Saby и сохранённый документ. Уже полученные номера и связи сохранены.',
      step: terminalStage ? (stage === 'rejected' ? 3 : 1) : afterConfirmation ? 4 : 1,
    }
  }
  if (result.phase === 'completed') return { title: 'ЭТрН созданы · ожидают обработки', text: 'В АРТЕЛЬ откройте каждую ЭТрН, проверьте заполнение и подпишите отправку клиенту. Состояния документов и подписей обновляются ниже.', step: 5 }
  if (result.phase === 'creating_etrn') return { title: 'АРТЕЛЬ · создание ЭТрН', text: 'По подтверждённой заявке создаётся отдельная ЭТрН для каждой доставки.', step: 4 }
  if (result.phase === 'awaiting_loading') return { title: 'Заявка подтверждена · нужны факты погрузки', text: 'НК АРТЕЛЬ подтвердило заявку. Внесите фактическую погрузку, чтобы CRM создала ЭТрН для клиентов.', step: 4 }
  if (stage === 'signature_pending') return { title: exchangeStageLabels[stage], text: 'Saby ожидает подтверждение владельца электронной подписи. После подписания CRM получит новое состояние документа.', step: 1 }
  if (stage === 'sender_action_required') return { title: exchangeStageLabels[stage], text: 'Черновик заявки готов. В кабинете АРТЕЛЬ откройте заявку, подпишите и нажмите «Отправить», чтобы передать её НК АРТЕЛЬ.', step: 1 }
  if (stage === 'sending_to_carrier') return { title: exchangeStageLabels[stage], text: 'Saby обрабатывает отправку. Дождитесь поступления заявки в НК АРТЕЛЬ.', step: 1 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'waiting') return { title: 'Ожидаем готовность ответа НК', text: 'Saby подготавливает входящую заявку. CRM проверит её готовность и заполнит доступные сведения автоматически.', step: 2 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'unknown') return { title: 'Проверяем заполнение НК', text: 'Результат записи ещё не подтверждён. CRM перечитывает ответ НК; повторная запись не выполняется.', step: 2 }
  if (stage === 'carrier_details_required' && ['partial', 'blocked'].includes(result.carrierFill?.state ?? '')) return { title: 'Заполнение НК · нужны уточнения', text: 'Подтверждённые сведения показаны ниже. Дополните недостающие данные в карточке водителя или машины и обновите состояние.', step: 2 }
  if (stage === 'carrier_details_required') return { title: exchangeStageLabels[stage], text: 'CRM заполняет ответ НК сведениями выбранного водителя и машины. Недостающие данные указаны ниже.', step: 2 }
  if (stage === 'carrier_action_required') return { title: exchangeStageLabels[stage], text: 'Ответ НК АРТЕЛЬ сохранён. Следующий шаг — проверка и утверждение после подключения подписи и МЧД.', step: 3 }
  if (stage === 'carrier_confirmation_pending') return { title: exchangeStageLabels[stage], text: 'Ответ перевозчика ещё проверяется. CRM продолжит цепочку после подтверждённого ответа Saby.', step: 3 }
  if (result.order?.id) return { title: 'Проверяем состояние заявки', text: 'Заявка сохранена в Saby. Обновите состояние или откройте её карточку, чтобы проверить текущий этап.', step: 1 }
  if (result.phase === 'submitting') return { title: 'Создаём заявку в АРТЕЛЬ', text: 'Дождитесь ответа Saby. Номер и ссылка появятся после проверки записи.', step: 0 }
  return { title: result.ready ? 'Рейс готов к созданию заявки' : 'Подготовка заявки', text: 'Одна общая заявка для НК АРТЕЛЬ, затем отдельная ЭТрН для каждой доставки клиенту.', step: 0 }
}

export function workflowTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ещё не выполнялась'
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value))
}
