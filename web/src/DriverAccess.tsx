import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { apiFetch } from './workspace-api'
import './driver-access.css'

type DriverAccessState = {
  driverId: string
  userId: string | null
  login: string | null
  active: boolean
  version: number
  status: 'not-issued' | 'active' | 'revoked'
  loginUrl: string
}

/** Passwords exist only in this mounted issuance panel, never in the directory draft. */
export default function DriverAccess({ driverId, disabled, onBusyChange }: { driverId: string; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [access, setAccess] = useState<DriverAccessState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [needsCheck, setNeedsCheck] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [confirmation, setConfirmation] = useState<'reset' | 'revoke' | null>(null)
  const submitting = useRef(false)
  const request = useRef(0)
  const endpoint = `/api/drivers/${encodeURIComponent(driverId)}/access`

  const refresh = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch(endpoint, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось проверить доступ водителя.')
      if (sequence === request.current) { setAccess(result.access); setNeedsCheck(false) }
    } catch (reason) {
      if (sequence === request.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.')
    } finally {
      if (sequence === request.current) setLoading(false)
    }
  }, [endpoint])

  useEffect(() => { void refresh(); return () => { request.current++ } }, [refresh])

  const change = async (action: 'issue' | 'reset' | 'revoke') => {
    if (submitting.current || disabled || needsCheck || !access) return
    submitting.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    setNotice('')
    setTemporaryPassword('')
    setShowPassword(false)
    setConfirmation(null)
    let responseReceived = false
    try {
      const response = await apiFetch(endpoint, {
        method: action === 'revoke' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'revoke' ? { version: access.version, active: false } : { version: access.version, action }),
      })
      const result = await response.json()
      responseReceived = true
      if (!response.ok) {
        if (response.status === 409) await refresh()
        throw new Error(result.error || 'Не удалось изменить доступ водителя.')
      }
      setAccess(result.access)
      if (typeof result.temporaryPassword === 'string') setTemporaryPassword(result.temporaryPassword)
      setNotice(action === 'revoke' ? 'Доступ отозван. Прежние сеансы завершены.' : result.temporaryPassword ? 'Данные входа готовы к передаче водителю.' : 'У водителя уже есть доступ. Для нового пароля выберите «Выдать новый пароль».')
    } catch (reason) {
      if (!responseReceived) {
        setNeedsCheck(true)
        setError('Результат изменения доступа не подтверждён. Проверьте доступ снова. Если пароль был создан, выдайте новый: повторно прочитать его нельзя.')
      } else setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.')
    } finally {
      submitting.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  const copyCredentials = async () => {
    if (!access?.login || !temporaryPassword) return
    try {
      await navigator.clipboard.writeText(`Вход: ${access.loginUrl}\nЛогин: ${access.login}\nПароль: ${temporaryPassword}`)
      setNotice('Данные входа скопированы. Передайте их водителю лично.')
    } catch {
      setError('Не удалось скопировать. Покажите пароль и скопируйте данные вручную.')
    }
  }

  return <section className="driver-access" aria-labelledby="driver-access-title">
    <div className="driver-access-heading"><ShieldCheck size={19}/><h3 id="driver-access-title">Доступ водителя</h3></div>
    <p className="driver-access-description">Личный кабинет показывает назначенные этому водителю рейсы и доставки. Изменения доступа сохраняются сразу.</p>
    {loading && !access && <p role="status"><LoaderCircle size={16} className="spin"/> Проверяем доступ…</p>}
    {access && <>
      <div className="shipment-field-grid">
        <label className="shipment-field"><span>Логин водителя</span><input aria-label="Логин водителя" value={access.login ?? ''} placeholder="Будет назначен при выдаче" readOnly autoComplete="off"/></label>
        <div className="shipment-field"><span>Состояние доступа</span><strong className={`driver-access-status ${access.active ? 'is-active' : ''}`}>{access.status === 'active' ? 'Доступ активен' : access.status === 'revoked' ? 'Доступ отозван' : 'Доступ ещё не выдан'}</strong></div>
      </div>
      <p className="driver-access-url">Адрес входа: <a href={access.loginUrl} target="_blank" rel="noreferrer">{access.loginUrl}</a></p>
      {!temporaryPassword && <div className="driver-access-actions">
        {access.status === 'not-issued' ? <button type="button" className="button" disabled={disabled || busy || loading || needsCheck} onClick={() => void change('issue')}><KeyRound size={16}/>Выдать доступ</button> : <button type="button" className="button" disabled={disabled || busy || loading || needsCheck} onClick={() => setConfirmation('reset')}><KeyRound size={16}/>Выдать новый пароль</button>}
        {access.active && <button type="button" className="button directory-danger" disabled={disabled || busy || loading || needsCheck} onClick={() => setConfirmation('revoke')}>Отозвать доступ</button>}
      </div>}
      {confirmation && <div className="driver-access-confirm" role="group" aria-label="Подтверждение изменения доступа">
        <p>{confirmation === 'reset' ? 'Создать новый пароль? Прежний пароль перестанет действовать, открытые сеансы водителя завершатся.' : 'Отозвать доступ? Водитель выйдет из кабинета и не сможет войти до новой выдачи пароля.'}</p>
        <div className="driver-access-actions"><button type="button" className="button primary" disabled={disabled || busy} onClick={() => void change(confirmation)}>{confirmation === 'reset' ? 'Подтвердить новый пароль' : 'Подтвердить отзыв'}</button><button type="button" className="button" onClick={() => setConfirmation(null)}>Отмена изменения доступа</button></div>
      </div>}
      {temporaryPassword && <div className="driver-access-secret" aria-label="Выданные данные входа">
        <p>Пароль доступен только сейчас. Передайте его водителю перед закрытием карточки. Повторно посмотреть пароль нельзя — можно выдать новый.</p>
        <label className="shipment-field"><span>Временный пароль водителя</span><span className="driver-access-password"><input aria-label="Временный пароль водителя" type={showPassword ? 'text' : 'password'} value={temporaryPassword} readOnly autoComplete="off" spellCheck={false}/><button type="button" className="icon-button" aria-label={showPassword ? 'Скрыть временный пароль' : 'Показать временный пароль'} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>
        <div className="driver-access-actions"><button type="button" className="button" onClick={() => void copyCredentials()}><Copy size={16}/>Скопировать данные входа</button><button type="button" className="button" onClick={() => { setTemporaryPassword(''); setShowPassword(false); setNotice('Пароль скрыт. Доступ водителя сохранён.') }}><Check size={16}/>Данные переданы</button></div>
      </div>}
    </>}
    {busy && <p role="status"><LoaderCircle size={16} className="spin"/> Сохраняем доступ…</p>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="driver-access-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={busy || loading} onClick={() => void refresh()}>Проверить доступ снова</button></div>}
  </section>
}
