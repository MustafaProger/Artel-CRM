import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
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
export default function DriverAccess({ driverId, disabled, onBusyChange, onChanged }: { driverId: string; disabled: boolean; onBusyChange: (busy: boolean) => void; onChanged?: () => void }) {
  const [access, setAccess] = useState<DriverAccessState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [needsCheck, setNeedsCheck] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [confirmation, setConfirmation] = useState<'issue' | 'reset' | 'revoke' | null>(null)
  const [customPassword, setCustomPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [showCustomPassword, setShowCustomPassword] = useState(false)
  const validPassword = password.length >= 12 && password.length <= 256 && password === repeatPassword
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

  const openConfirmation = (action: 'issue' | 'reset' | 'revoke', custom = false) => {
    setPassword('')
    setRepeatPassword('')
    setShowCustomPassword(false)
    setCustomPassword(custom)
    setConfirmation(action)
    setError('')
    setNotice('')
  }

  const cancelConfirmation = () => {
    setConfirmation(null)
    setPassword('')
    setRepeatPassword('')
    setCustomPassword(false)
    setShowCustomPassword(false)
  }

  const change = async (action: 'issue' | 'reset' | 'revoke') => {
    if (submitting.current || disabled || loading || needsCheck || !access) return
    if (action !== 'revoke' && customPassword && !validPassword) return
    submitting.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    setNotice('')
    setTemporaryPassword('')
    setShowPassword(false)
    let responseReceived = false
    try {
      const response = await apiFetch(endpoint, {
        method: action === 'revoke' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'revoke' ? { version: access.version, active: false } : { version: access.version, action, ...(customPassword ? { password } : {}) }),
      })
      const result = await response.json()
      responseReceived = true
      if (!response.ok) {
        if (response.status === 409) await refresh()
        throw new Error(result.error || 'Не удалось изменить доступ водителя.')
      }
      setAccess(result.access)
      onChanged?.()
      cancelConfirmation()
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
    <div className="driver-access-header">
      <div className="driver-access-heading"><ShieldCheck size={20}/><h3 id="driver-access-title">Доступ водителя</h3></div>
      {access && <span className={`driver-access-status ${access.active ? 'is-active' : ''}`}>{access.status === 'active' ? 'Доступ активен' : access.status === 'revoked' ? 'Доступ отозван' : 'Доступ ещё не выдан'}</span>}
    </div>
    <p className="driver-access-description">В личном кабинете водитель видит только свои рейсы и доставки.</p>
    {loading && !access && <p role="status"><LoaderCircle size={16} className="spin"/> Проверяем доступ…</p>}
    {access && <>
      <div className="driver-access-details">
        <label className="shipment-field"><span>Логин водителя</span><input aria-label="Логин водителя" value={access.login ?? ''} placeholder="Будет назначен при выдаче" readOnly autoComplete="off"/></label>
        <div className="driver-access-url"><span>Адрес входа</span><a href={access.loginUrl} target="_blank" rel="noreferrer">{access.loginUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}<ExternalLink size={14}/></a></div>
      </div>
      {!temporaryPassword && !confirmation && <div className="driver-access-controls">
        <div className="driver-access-actions">
          {access.status === 'not-issued' ? <button type="button" className="button primary" disabled={disabled || busy || loading || needsCheck} onClick={() => void change('issue')}><KeyRound size={16}/>Выдать доступ</button> : <button type="button" className="button" disabled={disabled || busy || loading || needsCheck} onClick={() => openConfirmation('reset')}><KeyRound size={16}/>Выдать новый пароль</button>}
          <button type="button" className="button" disabled={disabled || busy || loading || needsCheck} onClick={() => openConfirmation(access.status === 'not-issued' ? 'issue' : 'reset', true)}>Задать свой пароль</button>
        </div>
        {access.active && <button type="button" className="driver-access-revoke" disabled={disabled || busy || loading || needsCheck} onClick={() => openConfirmation('revoke')}>Отозвать доступ</button>}
      </div>}
      {confirmation && <div className="driver-access-confirm" role="group" aria-label="Подтверждение изменения доступа">
        <h4>{confirmation === 'revoke' ? 'Отзыв доступа' : customPassword ? 'Свой пароль' : 'Новый пароль'}</h4>
        <p>{confirmation === 'revoke' ? 'Водитель выйдет из кабинета и не сможет войти до новой выдачи пароля.' : confirmation === 'issue' ? 'Установите пароль для первого входа водителя.' : 'Прежний пароль перестанет действовать, открытые сеансы водителя завершатся.'}</p>
        {customPassword && <div className="driver-access-custom" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}>
          <label className="shipment-field"><span>Новый пароль водителя</span><span className="driver-access-password"><input aria-label="Новый пароль водителя" type={showCustomPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" spellCheck={false} disabled={disabled || busy} aria-describedby="driver-password-help" autoFocus/><button type="button" className="icon-button" disabled={busy} aria-label={showCustomPassword ? 'Скрыть введённый пароль' : 'Показать введённый пароль'} onClick={() => setShowCustomPassword(value => !value)}>{showCustomPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>
          <label className="shipment-field"><span>Повторите пароль</span><input aria-label="Повторите пароль" type={showCustomPassword ? 'text' : 'password'} value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)} maxLength={256} autoComplete="new-password" spellCheck={false} disabled={disabled || busy} aria-invalid={!!repeatPassword && password !== repeatPassword} aria-describedby="driver-password-help"/></label>
          <p id="driver-password-help" className="driver-access-hint" aria-live="polite">{repeatPassword && password !== repeatPassword ? 'Пароли не совпадают.' : 'От 12 до 256 символов.'}</p>
        </div>}
        <div className="driver-access-actions"><button type="button" className={`button ${confirmation === 'revoke' ? 'directory-danger' : 'primary'}`} disabled={disabled || busy || loading || needsCheck || (customPassword && !validPassword)} onClick={() => void change(confirmation)}>{confirmation === 'revoke' ? 'Подтвердить отзыв' : customPassword ? 'Сохранить пароль' : 'Подтвердить новый пароль'}</button><button type="button" className="button" disabled={busy} onClick={cancelConfirmation}>Отмена изменения доступа</button></div>
      </div>}
      {temporaryPassword && <div className="driver-access-secret" aria-label="Выданные данные входа">
        <p>Пароль доступен только сейчас. Передайте его водителю перед закрытием панели. Повторно посмотреть пароль нельзя — можно выдать новый.</p>
        <label className="shipment-field"><span>Временный пароль водителя</span><span className="driver-access-password"><input aria-label="Временный пароль водителя" type={showPassword ? 'text' : 'password'} value={temporaryPassword} readOnly autoComplete="off" spellCheck={false}/><button type="button" className="icon-button" aria-label={showPassword ? 'Скрыть временный пароль' : 'Показать временный пароль'} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></span></label>
        <div className="driver-access-actions"><button type="button" className="button" onClick={() => void copyCredentials()}><Copy size={16}/>Скопировать данные входа</button><button type="button" className="button" onClick={() => { setTemporaryPassword(''); setShowPassword(false); setNotice('Пароль скрыт. Доступ водителя сохранён.') }}><Check size={16}/>Данные переданы</button></div>
      </div>}
    </>}
    <p className="driver-access-footnote">Изменения доступа сохраняются сразу. Данные водителя в справочнике сохраняются отдельно.</p>
    {busy && <p role="status"><LoaderCircle size={16} className="spin"/> Сохраняем доступ…</p>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="driver-access-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={busy || loading} onClick={() => void refresh()}>Проверить доступ снова</button></div>}
  </section>
}
