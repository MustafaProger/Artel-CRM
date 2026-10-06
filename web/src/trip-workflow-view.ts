import type { TripSabyOrderSummary, TripSabyResponse, TripSabySigningStep } from './trip-saby-model'

export function workflowDate(value: string | null | undefined) {
  let normalized = value?.trim() || ''
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(normalized)) normalized = normalized.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00Z'
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/, '$1T$2Z')
  // Require an explicit timezone for timestamps so every browser shows the same
  // Moscow date. Invalid or missing values never fall back to the device zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return 'дата неизвестна'
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) return 'дата неизвестна'
  const day = normalized.slice(0, 10)
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return 'дата неизвестна'
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date(timestamp))
}

export function workflowOrderLabel(order: Pick<TripSabyOrderSummary, 'number' | 'date'>) {
  const displayDate = workflowDate(order.date)
  return `Заявка${order.number ? ` № ${order.number}` : ' · номер ожидается'}${displayDate !== 'дата неизвестна' ? ` от ${displayDate}` : ' · дата уточняется'}`
}

export function signingStepView(step: TripSabySigningStep, side: 'sender' | 'carrier') {
  const organization = side === 'sender' ? 'АРТЕЛЬ' : 'НК АРТЕЛЬ'
  const views = {
    not_started: { title: 'Ожидает своего этапа', text: side === 'sender' ? 'Подписание начнётся только после вашего запуска.' : 'CRM дождётся отправки АРТЕЛЬ и проверенного заполнения ответа НК.' },
    preparing: { title: 'Подготавливаем подписание', text: 'CRM проверяет заявку и сохраняет сведения для подписания.' },
    requested: { title: 'Запрос на подпись передан', text: 'Ожидаем результат Saby. Повторный запрос не отправляется.' },
    waiting: { title: 'Ожидаем подпись', text: 'Может потребоваться подтверждение владельца или доступный компьютер с подписью и запущенным Saby. CRM проверяет результат автоматически.' },
    unknown: { title: 'Сверяем результат подписания', text: 'Ответ Saby не получен полностью. CRM перечитывает заявку; повторная отправка не выполняется.' },
    confirmed: { title: 'Подпись подтверждена в Saby', text: side === 'sender' ? 'Подписанная заявка АРТЕЛЬ получена обратно из Saby.' : 'Подписанный ответ НК и подтверждение заявки получены из Saby.' },
    blocked: { title: 'Подписание приостановлено', text: 'Нужна проверка сообщения ниже. Повторная отправка не выполняется.' },
  }
  const view = views[step.state]
  return { ...view, text: step.message || view.text, organization }
}

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
  if (result.signing && result.signing.state !== 'completed') {
    const side = result.signing.sender.state === 'confirmed' ? 'carrier' : 'sender'
    const signing = result.signing[side]
    if (signing.state !== 'not_started' && signing.state !== 'confirmed') {
      const view = signingStepView(signing, side)
      return { title: `${view.organization} · ${view.title.toLocaleLowerCase('ru-RU')}`, text: view.text, step: side === 'sender' ? 1 : 3 }
    }
  }
  if (stage === 'signature_pending') return { title: exchangeStageLabels[stage], text: 'Saby ещё не подтвердил подпись. Может потребоваться подтверждение владельца или доступный компьютер с подписью. CRM проверит результат.', step: 1 }
  if (stage === 'sender_action_required') return { title: exchangeStageLabels[stage], text: 'Черновик заявки готов. Проверьте доступные подписи ниже и запустите подписание этой заявки из CRM.', step: 1 }
  if (stage === 'sending_to_carrier') return { title: exchangeStageLabels[stage], text: 'Saby обрабатывает отправку. Дождитесь поступления заявки в НК АРТЕЛЬ.', step: 1 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'waiting') return { title: 'Ожидаем готовность ответа НК', text: 'Saby подготавливает входящую заявку. CRM проверит её готовность и заполнит доступные сведения автоматически.', step: 2 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'unknown') return { title: 'Проверяем заполнение НК', text: 'Результат записи ещё не подтверждён. CRM перечитывает ответ НК; повторная запись не выполняется.', step: 2 }
  if (stage === 'carrier_details_required' && ['partial', 'blocked'].includes(result.carrierFill?.state ?? '')) return { title: 'Заполнение НК · нужны уточнения', text: 'Подтверждённые сведения показаны ниже. Дополните недостающие данные в карточке водителя или машины и обновите состояние.', step: 2 }
  if (stage === 'carrier_details_required') return { title: exchangeStageLabels[stage], text: 'CRM заполняет ответ НК сведениями выбранного водителя и машины. Недостающие данные указаны ниже.', step: 2 }
  if (stage === 'carrier_action_required') return { title: exchangeStageLabels[stage], text: 'Ответ НК АРТЕЛЬ сохранён. После запуска подписания CRM передаст его на утверждение выбранной подписью НК и проверит результат.', step: 3 }
  if (stage === 'carrier_confirmation_pending') return { title: exchangeStageLabels[stage], text: 'Ответ перевозчика ещё проверяется. CRM продолжит цепочку после подтверждённого ответа Saby.', step: 3 }
  if (result.order?.id) return { title: 'Проверяем состояние заявки', text: 'Заявка сохранена в Saby. Обновите состояние или откройте её карточку, чтобы проверить текущий этап.', step: 1 }
  if (result.phase === 'submitting') return { title: 'Создаём заявку в АРТЕЛЬ', text: 'Дождитесь ответа Saby. Номер и ссылка появятся после проверки записи.', step: 0 }
  return { title: result.ready ? 'Рейс готов к созданию заявки' : 'Подготовка заявки', text: 'Одна общая заявка для НК АРТЕЛЬ, затем отдельная ЭТрН для каждой доставки клиенту.', step: 0 }
}

export function workflowTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ещё не выполнялась'
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value))
}
