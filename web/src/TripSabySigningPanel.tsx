import { useEffect, useRef, useState } from 'react'
import { Check, Clock3, LoaderCircle, PenLine, RefreshCw } from 'lucide-react'
import { apiFetch as fetch } from './workspace-api'
import type { TripSabyAutomation, TripSabyOrderSummary, TripSabyResponse, TripSabySigning, TripSabySigningPreview, TripSabySigningStartRequest } from './trip-saby-model'
import { signingStepView, workflowDate, workflowOrderLabel, workflowTime } from './trip-workflow-view'

interface Props {
  endpoint: string
  order: TripSabyOrderSummary
  signing?: TripSabySigning
  automation?: TripSabyAutomation
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onWorkflowChange: (workflow: TripSabyResponse) => Promise<void>
  onRefresh: () => Promise<void>
  onReconcile: () => Promise<void>
}

const sides = [['sender', 'АРТЕЛЬ', 'Подпись АРТЕЛЬ'], ['carrier', 'НК АРТЕЛЬ', 'Подпись НК АРТЕЛЬ']] as const

export default function TripSabySigningPanel({ endpoint, order, signing, automation, disabled, onBusyChange, onWorkflowChange, onRefresh, onReconcile }: Props) {
  const [preview, setPreview] = useState<TripSabySigningPreview | null>(null)
  const [selections, setSelections] = useState({ sender: '', carrier: '' })
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const lock = useRef(false), mounted = useRef(true), requestId = useRef<string | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const operation = signing || preview?.signing
  const automatic = automation?.enabled === true
  const legacyAutomatic = automatic && !automation?.enrolled
  const currentPreview = preview && preview.order.id === order.id && preview.order.revision === order.revision && preview.order.number === order.number && preview.order.date === order.date
  const selected = preview && sides.every(([side]) => preview[side].signatures.some(signature => signature.id === selections[side]))
  const canStart = !automatic && !!currentPreview && preview.ready && !!preview.previewToken && !!order.number && !!order.date && !!selected && confirmed && !operation && !uncertain && !busy && !disabled

  const readPreview = async () => {
    const response = await fetch(`${endpoint}/signing`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Не удалось проверить доступные подписи')
    return body as TripSabySigningPreview
  }
  const applyPreview = (body: TripSabySigningPreview) => {
    if (!mounted.current) return
    setPreview(body)
    setSelections({ sender: body.sender.signatures.length === 1 ? body.sender.signatures[0].id : '', carrier: body.carrier.signatures.length === 1 ? body.carrier.signatures[0].id : '' })
    setConfirmed(false)
    if (body.signing) setUncertain(false)
  }
  const inspect = async () => {
    if (lock.current || disabled) return
    lock.current = true; setBusy(true); onBusyChange(true); setError(''); setConfirmed(false)
    try {
      if (legacyAutomatic || automatic && !operation) {
        await onRefresh()
      } else if (operation) {
        await onReconcile()
      } else {
        // No saved signing task: even after an uncertain start, this button only
        // reads. It must never create permission to sign by trying to reconcile.
        const body = await readPreview()
        applyPreview(body)
        if (body.signing) await onRefresh()
      }
    } catch (reason) {
      if (mounted.current) { setPreview(null); setError(reason instanceof Error ? reason.message : 'Нет связи с CRM. Проверка подписей не завершена.') }
    } finally {
      lock.current = false
      if (mounted.current) { setBusy(false); onBusyChange(false) }
    }
  }
  const start = async () => {
    if (lock.current || !canStart || !preview?.previewToken) return
    lock.current = true; setBusy(true); onBusyChange(true); setError('')
    requestId.current ||= crypto.randomUUID()
    const payload: TripSabySigningStartRequest = { requestId: requestId.current, previewToken: preview.previewToken, senderSignatureId: selections.sender, carrierSignatureId: selections.carrier, confirmed: true }
    let rejected = false
    try {
      const response = await fetch(`${endpoint}/signing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await response.json()
      if (!response.ok) { rejected = response.status >= 400 && response.status < 500; throw new Error(body.error || 'Не удалось запустить подписание') }
      if (mounted.current) { setConfirmed(false); setUncertain(false); await onWorkflowChange(body) }
    } catch (reason) {
      if (!mounted.current) return
      setConfirmed(false); setUncertain(!rejected)
      setError(reason instanceof Error ? reason.message : 'Ответ запуска не получен. Сверяем состояние заявки.')
      // Read back first after any lost response. Keep the launch blocked if even
      // successful reads cannot prove whether this request was saved.
      try {
        const body = await readPreview()
        applyPreview(body)
        await onRefresh()
      } catch { if (mounted.current) setPreview(null) }
      if (rejected) requestId.current = null
    } finally {
      lock.current = false
      if (mounted.current) { setBusy(false); onBusyChange(false) }
    }
  }

  return <section className="workflow-signing" aria-label="Подписание заявки" aria-busy={busy}>
    <header><h4>{automatic ? legacyAutomatic ? 'Состояние подписи' : 'Автоматическое подписание' : 'Подписание из CRM'}</h4><span>{workflowOrderLabel(order)}</span></header>
    <p className="etrn-note">{automatic ? legacyAutomatic ? 'Сохранено состояние ранее начатого обмена. Автоматический режим не запускает повторную отправку этой заявки.' : 'После сохранения рейса CRM автоматически обрабатывает заявку и запрашивает подписи обеих сторон. Результаты Saby показаны ниже.' : 'После запуска CRM запросит подпись и отправку заявки АРТЕЛЬ, затем заполнит ответ НК и запросит его подпись. Если Saby потребует согласие владельца, его нужно подтвердить.'}</p>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {uncertain && !operation && <p className="workflow-sync-warning" role="status">Результат запуска пока неизвестен. Повторный запуск заблокирован: сначала нужно получить сохранённое состояние из Saby.</p>}
    {(operation || preview) && <ul className="workflow-signing-sides">{sides.map(([side, organization, label]) => {
      const state = operation?.[side]
      const status = state ? signingStepView(state, side, operation?.mode) : null
      const options = preview?.[side]
      const chosen = options?.signatures.find(signature => signature.id === selections[side])
      const expiresOn = workflowDate(chosen?.expiresAt)
      return <li className="workflow-signing-side" key={side}>
        <strong>{state?.state === 'confirmed' ? <Check size={17} aria-hidden="true"/> : <Clock3 size={17} aria-hidden="true"/>}{options?.organization || organization}</strong>
        {status && <><p><strong>{status.title}</strong></p><p>{status.text}</p></>}
        {!automatic && !operation && options && <>
          {options.signatures.length ? <label className="shipment-field"><span>{label}</span><select value={selections[side]} disabled={busy || disabled || uncertain || !currentPreview} onChange={event => { setSelections(previous => ({ ...previous, [side]: event.target.value })); setConfirmed(false) }}>
            <option value="">Выберите подпись</option>{options.signatures.map(signature => <option key={signature.id} value={signature.id}>{signature.owner || 'Владелец не указан'}</option>)}
          </select></label> : <p>При этой проверке Saby не вернул доступных подписей. Проверьте доступ к подписи для этой организации.</p>}
          {chosen && <p>{chosen.owner || 'Владелец не указан'} · {expiresOn === 'дата неизвестна' ? 'срок действия неизвестен' : `действует до ${expiresOn}`}</p>}
          {options.message && <p>{options.message}</p>}
        </>}
      </li>
    })}</ul>}
    {!automatic && !operation && preview && <>
      <p className="etrn-note">Подписи проверены {workflowTime(preview.checkedAt)} · Москва. Наличие подписи в списке ещё не подтверждает, что Saby сможет использовать её для этой заявки.</p>
      {!currentPreview && <p className="workflow-sync-warning" role="status">Заявка изменилась после проверки. Проверьте подписи заново перед запуском.</p>}
      {!!preview.blockers.length && <ul className="workflow-fill-blockers">{preview.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
      <label className="workflow-signing-confirmation"><input type="checkbox" checked={confirmed && !!currentPreview} disabled={busy || disabled || uncertain || !currentPreview || !preview.ready || !selected} onChange={event => setConfirmed(event.target.checked)}/><span>Подтверждаю подписание и отправку: {workflowOrderLabel(order)}. Использовать выбранные подписи АРТЕЛЬ и НК АРТЕЛЬ.</span></label>
    </>}
    {operation && <p className="etrn-note" role="status">{operation.state === 'completed' ? 'Подписание обеих сторон подтверждено.' : operation.state === 'blocked' ? 'Подписание приостановлено. Причина указана выше.' : operation.state === 'unknown' ? 'Продолжение приостановлено до подтверждения последней операции. Повторная отправка не выполняется.' : legacyAutomatic ? 'Показано сохранённое состояние прежнего обмена.' : 'Запуск сохранён. CRM продолжает эту цепочку и после закрытия страницы.'} Запущено {workflowTime(operation.requestedAt)} · Москва.</p>}
    <div className="etrn-actions">
      {!automatic && !operation && preview && <button type="button" className="button primary" disabled={!canStart} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <PenLine size={16} aria-hidden="true"/>}Подписать и продолжить обмен</button>}
      {!automatic && (!operation || operation.state !== 'completed') && <button type="button" className="button" disabled={busy || disabled} onClick={() => void inspect()}><RefreshCw size={15} aria-hidden="true"/>{operation || uncertain ? 'Сверить состояние подписания' : preview ? 'Проверить подписи заново' : 'Проверить доступные подписи'}</button>}
    </div>
  </section>
}
