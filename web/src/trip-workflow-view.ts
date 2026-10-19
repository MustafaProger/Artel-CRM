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

export function signingStepView(step: TripSabySigningStep, side: 'sender' | 'carrier', mode: 'automatic' | 'with_confirmation' = 'with_confirmation') {
  const organization = side === 'sender' ? 'АРТЭЛЬ' : 'НК АРТЭЛЬ'
  const views = {
    not_started: { title: 'Ожидает своего этапа', text: side === 'sender' ? mode === 'automatic' ? 'CRM проверит сохранённую заявку и запросит подпись автоматически.' : 'Подписание начнётся только после вашего запуска.' : 'CRM дождётся отправки АРТЭЛЬ и проверенного заполнения ответа НК.' },
    preparing: { title: 'Подготавливаем подписание', text: 'CRM проверяет заявку и сохраняет сведения для подписания.' },
    requested: { title: 'Запрос на подпись передан', text: 'Ожидаем результат Saby. Повторный запрос не отправляется.' },
    waiting: { title: 'Ожидаем подпись', text: mode === 'automatic' ? 'Saby ещё не подтвердил подпись. CRM автоматически проверяет результат.' : 'Может потребоваться подтверждение владельца или доступный компьютер с подписью и запущенным Saby. CRM проверяет результат автоматически.' },
    unknown: { title: 'Результат подписания не подтверждён', text: 'Результат последней операции Saby неизвестен. Продолжение приостановлено; повторная отправка не выполняется.' },
    confirmed: { title: 'Подпись подтверждена в Saby', text: side === 'sender' ? 'Подписанная заявка АРТЭЛЬ получена обратно из Saby.' : 'Подписанный ответ НК и подтверждение заявки получены из Saby.' },
    blocked: { title: 'Подписание приостановлено', text: 'Нужна проверка сообщения ниже. Повторная отправка не выполняется.' },
  }
  const view = views[step.state]
  return { ...view, text: step.message || view.text, organization }
}

export const exchangeStageLabels: Record<string, string> = {
  sender_action_required: 'АРТЭЛЬ · подпись и отправка',
  sending_to_carrier: 'Заявка передаётся в НК АРТЭЛЬ',
  signature_pending: 'Ожидаем электронную подпись',
  carrier_details_required: 'НК АРТЭЛЬ · водитель и машина',
  carrier_action_required: 'НК АРТЭЛЬ · подпись и утверждение',
  carrier_confirmation_pending: 'Ожидаем подтверждение Saby',
  carrier_confirmed: 'НК АРТЭЛЬ подтвердило заявку',
  rejected: 'НК АРТЭЛЬ отклонило заявку',
  operator_error: 'Ошибка обработки Saby',
  cancelled: 'Заявка аннулирована',
  unknown: 'Состояние уточняется',
}

/** Driver confirmation is an accepted departure action, never a Saby signature. */
export function driverConfirmedAt(result: TripSabyResponse) {
  const value = result.driverConfirmation?.confirmedAt
  return value && Number.isFinite(Date.parse(value)) ? value : null
}

export function workflowSteps(result: TripSabyResponse, currentStep: number) {
  const labels = ['Подготовка', 'Подтверждение водителя', 'Отправка АРТЭЛЬ', 'Водитель и машина', 'Подтверждение НК', 'Создание ЭТрН', 'Отправка клиентам']
  return labels.map((label, index) => {
    // A later exchange stage does not prove that an older trip used the driver
    // cabinet. Keep that independent fact unconfirmed even in completed trips.
    const done = index === 1 ? !!driverConfirmedAt(result) : index < currentStep
    const state = done ? 'done' : index === currentStep ? 'current' : index === 1 && currentStep > 1 ? 'unconfirmed' : 'pending'
    return { label, state, note: state === 'unconfirmed' ? 'Не зафиксировано' : undefined }
  })
}

export function workflowView(result: TripSabyResponse, hasLoadingFacts = false): { title: string; text: string; step: number; requiresReconciliation?: boolean } {
  const stage = result.order?.exchangeStage
  const confirmedAt = driverConfirmedAt(result)
  const beforeSender = result.order?.id ? confirmedAt || hasLoadingFacts || result.driverFlow?.state === 'mass_pending' ? 2 : 1 : 0
  if (result.stage6CompletedAt) return { title: confirmedAt ? 'Все этапы рейса завершены' : 'Обмен с Saby завершён', text: `Подписи и отправка ЭТрН клиентам подтверждены для каждой доставки. ${confirmedAt ? 'Рейс доступен водителю в архиве.' : 'Подтверждение водителя в CRM не зафиксировано.'}`, step: 7 }
  const afterConfirmation = stage === 'carrier_confirmed' || result.carrierConfirmed
  if (result.phase === 'unknown') {
    if (afterConfirmation && (!result.driverFlow || result.driverFlow.state === 'ready')) return {
      title: 'Создание ЭТрН · нужна сверка',
      text: 'Подтверждение НК получено. Результат создания ЭТрН пока не установлен; повторная накладная не создаётся.',
      step: 5,
    }
    return { title: 'Нужна сверка с Saby', text: 'Ответ не подтверждён. Продолжение приостановлено; повторная заявка не создаётся.', step: result.driverFlow && result.driverFlow.state !== 'ready' ? beforeSender : result.signing?.sender.state === 'confirmed' ? 4 : 2 }
  }
  if (result.phase === 'error') {
    const terminalStage = stage === 'rejected' || stage === 'operator_error' || stage === 'cancelled'
    if (result.driverFlow && result.driverFlow.state !== 'ready') return { title: 'Подготовка заявки приостановлена', text: 'Проверьте сообщение ниже. Подписание не запускалось; сохранённые данные водителя и связь с заявкой остаются в CRM.', step: beforeSender }
    return {
      title: terminalStage ? exchangeStageLabels[stage] : afterConfirmation ? 'Создание ЭТрН приостановлено' : 'Обмен приостановлен',
      text: 'Проверьте сообщение Saby и сохранённый документ. Уже полученные номера и связи сохранены.',
      step: terminalStage ? (stage === 'rejected' ? 4 : 2) : afterConfirmation ? 5 : 2,
    }
  }
  if (result.driverFlow?.state === 'mass_pending') return { title: 'Массы получены · дополняем заявку', text: 'CRM проверяет сохранение масс всех доставок в той же заявке. Подписание начнётся после подтверждённого сохранения.', step: beforeSender }
  if (result.phase === 'awaiting_driver' || result.driverFlow?.state === 'waiting_driver') {
    if (confirmedAt || hasLoadingFacts) return {
      title: confirmedAt ? 'Данные водителя получены · ожидают обработки' : 'Факты погрузки сохранены · ожидают обработки',
      text: result.order?.id ? 'CRM продолжит обработку сохранённых сведений и проверит их запись в Saby. Отправка АРТЭЛЬ начнётся после подтверждённого сохранения масс.' : 'Сведения сохранены в CRM. Создание черновика и передача этих сведений в Saby ещё не подтверждены.',
      step: beforeSender,
    }
    return {
      title: result.order?.id ? 'Черновик заявки · ожидаем водителя' : 'Подготовка · ожидаем водителя',
      text: result.order?.id ? result.driverConfirmation?.arrivedAt ? 'Водитель зафиксировал прибытие. Ожидаем массы всех доставок и подтверждение кнопкой «Убыл».' : 'Неподписанная заявка сохранена в Saby. Водитель фиксирует прибытие, затем вводит массы всех доставок и нажимает «Убыл». До этого отправка не начнётся.' : 'Водитель может фиксировать прибытие и массы. Создание неподписанного черновика в Saby ещё не подтверждено; состояние подготовки показано ниже.',
      step: beforeSender,
    }
  }
  if (result.phase === 'sending_etrn' || result.phase === 'completed' && result.driverFlow) return { title: 'ЭТрН созданы · отправка клиентам', text: 'CRM проверяет подписи и отправку каждой ЭТрН клиенту. Рейс остаётся активным до подтверждения всех доставок.', step: 6 }
  if (result.phase === 'completed') return { title: 'ЭТрН созданы · ожидают обработки', text: 'В АРТЭЛЬ откройте каждую ЭТрН, проверьте заполнение и подпишите отправку клиенту. Состояния документов и подписей обновляются ниже.', step: 6 }
  if (result.phase === 'creating_etrn') return { title: 'АРТЭЛЬ · создание ЭТрН', text: 'По подтверждённой заявке создаётся отдельная ЭТрН для каждой доставки.', step: 5 }
  if (result.phase === 'awaiting_loading') return result.driverFlow
    ? { title: 'Заявка подтверждена · проверяем погрузку', text: 'CRM проверяет ранее сохранённые водителем массы и события перед созданием ЭТрН для клиентов.', step: 5 }
    : { title: 'Заявка подтверждена · нужны факты погрузки', text: 'НК АРТЭЛЬ подтвердило заявку. Внесите фактическую погрузку, чтобы CRM создала ЭТрН для клиентов.', step: 5 }
  if (result.phase === 'preparation' && hasLoadingFacts && !result.order?.id && !result.automation?.enrolled && result.start?.mode !== 'sign_and_send') return {
    title: 'Факты погрузки сохранены · нужна сверка Saby',
    text: 'Факты погрузки есть в CRM, но связь с заявкой Saby и включение рейса в автоматический обмен не подтверждены. Требуется сверка состояния документов.',
    step: 0,
    requiresReconciliation: true,
  }
  if (result.automation?.enabled && !result.order?.id) {
    if (!result.ready) return { title: 'Рейс сохранён · отправка приостановлена', text: result.automation.message || 'Исправьте сведения, перечисленные ниже, и обновите состояние перед запуском обмена.', step: 0 }
    return result.automation.enrolled
      ? { title: 'Автоматическая отправка в очереди', text: result.automation.message || 'CRM создаёт общую заявку и запрашивает подписи обеих организаций. Дополнительных действий в CRM не требуется.', step: 0 }
      : { title: 'Автоматический обмен не запущен', text: result.automation.message || (result.start ? 'Сведения готовы. Нажмите «Запустить обмен», чтобы создать неподписанный черновик Saby.' : 'Этот рейс ещё не включён в автоматический обмен. Сохранение изменений не запускает отправку.'), step: 0 }
  }
  if (result.signing && result.signing.state !== 'completed') {
    const side = result.signing.sender.state === 'confirmed' ? 'carrier' : 'sender'
    const signing = result.signing[side]
    if (signing.state !== 'not_started' && signing.state !== 'confirmed') {
      const view = signingStepView(signing, side, result.signing.mode)
      return { title: `${view.organization} · ${view.title.toLocaleLowerCase('ru-RU')}`, text: view.text, step: side === 'sender' ? 2 : 4 }
    }
  }
  if (result.automation?.enabled && !result.automation.enrolled && result.order?.id && !result.signing) return { title: 'Состояние существующей заявки', text: result.automation.message || 'Включение автоматического режима не запускает повторную отправку ранее созданной заявки.', step: result.order.exchangeStage === 'carrier_action_required' ? 4 : 2 }
  if (stage === 'signature_pending') return { title: exchangeStageLabels[stage], text: 'Saby ещё не подтвердил подпись. Может потребоваться подтверждение владельца или доступный компьютер с подписью. CRM проверит результат.', step: 2 }
  if (stage === 'sender_action_required') return { title: exchangeStageLabels[stage], text: result.automation?.enabled && result.automation.enrolled ? 'CRM проверяет сохранённую заявку и автоматически запрашивает подпись отправителя.' : 'Черновик заявки готов. Проверьте доступные подписи ниже и запустите подписание этой заявки из CRM.', step: 2 }
  if (stage === 'sending_to_carrier') return { title: exchangeStageLabels[stage], text: 'Saby обрабатывает отправку. Дождитесь поступления заявки в НК АРТЭЛЬ.', step: 2 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'waiting') return { title: 'Ожидаем готовность ответа НК', text: 'Saby подготавливает входящую заявку. CRM проверит её готовность и заполнит доступные сведения автоматически.', step: 3 }
  if (stage === 'carrier_details_required' && result.carrierFill?.state === 'unknown') return { title: 'Проверяем заполнение НК', text: 'Результат записи ещё не подтверждён. CRM перечитывает ответ НК; повторная запись не выполняется.', step: 3 }
  if (stage === 'carrier_details_required' && ['partial', 'blocked'].includes(result.carrierFill?.state ?? '')) return { title: 'Заполнение НК · нужны уточнения', text: 'Подтверждённые сведения показаны ниже. Дополните недостающие данные в карточке водителя или машины и обновите состояние.', step: 3 }
  if (stage === 'carrier_details_required') return { title: exchangeStageLabels[stage], text: 'CRM заполняет ответ НК сведениями выбранного водителя и машины. Недостающие данные указаны ниже.', step: 3 }
  if (stage === 'carrier_action_required') return { title: exchangeStageLabels[stage], text: result.automation?.enabled && result.automation.enrolled ? 'Ответ НК АРТЭЛЬ сохранён. CRM автоматически запрашивает подпись НК и проверяет результат.' : 'Ответ НК АРТЭЛЬ сохранён. После запуска подписания CRM передаст его на утверждение выбранной подписью НК и проверит результат.', step: 4 }
  if (stage === 'carrier_confirmation_pending') return { title: exchangeStageLabels[stage], text: 'Ответ перевозчика ещё проверяется. CRM продолжит цепочку после подтверждённого ответа Saby.', step: 4 }
  if (result.order?.id) return { title: 'Проверяем состояние заявки', text: 'Заявка сохранена в Saby. Обновите состояние или откройте её карточку, чтобы проверить текущий этап.', step: 2 }
  if (result.phase === 'submitting') return { title: 'Создаём заявку в АРТЭЛЬ', text: 'Дождитесь ответа Saby. Номер и ссылка появятся после проверки записи.', step: 0 }
  return { title: result.ready ? 'Рейс готов к созданию заявки' : 'Подготовка заявки', text: 'Одна общая заявка для НК АРТЭЛЬ, затем отдельная ЭТрН для каждой доставки клиенту.', step: 0 }
}

export function workflowTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ещё не выполнялась'
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value))
}
