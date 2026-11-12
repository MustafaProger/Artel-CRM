import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import type { AccountUser, SessionState } from './auth-model'
import { apiFetch } from './workspace-api'
import ProfileAvatarPicker from './ProfileAvatarPicker'
import './personal-profile-settings.css'

type ProfileSection = 'identity' | 'password' | 'avatar'
type ProfileChange = { name: string; login: string } | { currentPassword: string; newPassword: string } | { avatar: string | null }
type Feedback = { section: ProfileSection; kind: 'error' | 'success'; message: string }

const emptyPasswords = { currentPassword: '', newPassword: '', repeatedPassword: '' }
type IdentityDraft = { login: string; name: string }
const validLogin = /^[a-z0-9._-]{3,64}$/

function savedMessage(change: ProfileChange) {
  if ('avatar' in change) return change.avatar ? 'Фото профиля сохранено.' : 'Фото профиля удалено.'
  return 'name' in change ? 'Имя и логин сохранены.' : 'Пароль изменён.'
}

export default function PersonalProfileSettings({ user, onUserChanged }: {
  user: AccountUser
  onUserChanged: (user: AccountUser) => void
}) {
  const id = useId()
  const repeatInput = useRef<HTMLInputElement>(null)
  const loginInput = useRef<HTMLInputElement>(null)
  const pencil = useRef<HTMLButtonElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const [identity, setIdentity] = useState<IdentityDraft | null>(null)
  const [passwords, setPasswords] = useState(emptyPasswords)
  const [saving, setSaving] = useState<ProfileSection | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  const editing = identity !== null
  useEffect(() => { if (editing) loginInput.current?.focus() }, [editing])

  const nextIdentity = identity && { login: identity.login.trim().toLowerCase(), name: identity.name.trim() }
  const identityChanged = nextIdentity && (nextIdentity.login !== user.login || nextIdentity.name !== user.name)
  const mismatch = !!passwords.repeatedPassword && passwords.repeatedPassword !== passwords.newPassword

  const clearFeedback = (section: ProfileSection) => {
    setFeedback(current => current?.section === section ? null : current)
  }

  const save = async (section: ProfileSection, input: ProfileChange | (() => Promise<ProfileChange>)) => {
    if (activeRequest.current) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new DOMException('Profile request timed out', 'TimeoutError')), 15000)
    activeRequest.current = controller
    setSaving(section)
    setFeedback(null)
    try {
      const change = typeof input === 'function' ? await input() : input
      controller.signal.throwIfAborted()
      const response = await apiFetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Artel-Account': user.id },
        body: JSON.stringify({ version: user.version, ...change }),
        signal: controller.signal,
      })
      const result = await response.json().catch(() => null) as { user?: AccountUser; error?: string } | null
      controller.signal.throwIfAborted()
      if (response.status === 409) {
        const current = await apiFetch('/api/auth/session', { cache: 'no-store', signal: controller.signal })
        if (current.ok) {
          const { user: latest } = await current.json().catch(() => ({})) as Partial<SessionState>
          if (!controller.signal.aborted && latest?.id === user.id) onUserChanged(latest)
        }
        throw new Error(result?.error || 'Профиль изменился. Проверьте данные и повторите сохранение.')
      }
      if (!response.ok || result?.user?.id !== user.id) {
        throw new Error(result?.error || 'Не удалось сохранить профиль.')
      }
      onUserChanged(result.user)
      if (section === 'identity') {
        setIdentity(null)
        pencil.current?.focus()
      }
      if (section === 'password') setPasswords(emptyPasswords)
      setFeedback({ section, kind: 'success', message: savedMessage(change) })
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.name === 'AbortError') return
      const message = error instanceof TypeError || controller.signal.aborted
        ? 'Не удалось подтвердить сохранение. Проверьте соединение.'
        : error instanceof Error ? error.message : 'Не удалось сохранить профиль.'
      setFeedback({ section, kind: 'error', message })
    } finally {
      clearTimeout(timeout)
      activeRequest.current = null
      setSaving(null)
    }
  }

  const toggleIdentity = () => {
    if (activeRequest.current) return
    clearFeedback('identity')
    setIdentity(current => current ? null : { name: user.name, login: user.login })
  }

  const changeIdentity = (field: keyof IdentityDraft, value: string) => {
    setIdentity(current => current && { ...current, [field]: value })
    clearFeedback('identity')
  }

  const submitIdentity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!nextIdentity || !identityChanged) return
    const error = !nextIdentity.name ? 'Введите имя.'
      : !validLogin.test(nextIdentity.login) ? 'Логин должен содержать от 3 до 64 латинских букв, цифр, точек, дефисов или подчёркиваний.' : ''
    if (error) {
      setFeedback({ section: 'identity', kind: 'error', message: error })
      return
    }
    void save('identity', nextIdentity)
  }

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mismatch) {
      repeatInput.current?.focus()
      return
    }
    const { currentPassword, newPassword } = passwords
    if (currentPassword && newPassword.length >= 12 && passwords.repeatedPassword === newPassword) {
      void save('password', { currentPassword, newPassword })
    }
  }

  const setPassword = (field: keyof typeof emptyPasswords, value: string) => {
    setPasswords(current => ({ ...current, [field]: value }))
    clearFeedback('password')
  }

  const renderFeedback = (section: ProfileSection) => feedback?.section === section &&
    <p className="personal-profile-feedback" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>

  return <div className="personal-profile">
    <ProfileAvatarPicker user={user} busy={!!saving} saving={saving === 'avatar'} feedback={renderFeedback('avatar')}
      onSave={avatar => void save('avatar', typeof avatar === 'function' ? async () => ({ avatar: await avatar() }) : { avatar })}>
      <form className="personal-profile-identity" data-editing={editing} aria-label="Имя и логин" aria-busy={saving === 'identity'}
        onSubmit={submitIdentity} onKeyDown={event => {
          if (event.key === 'Escape' && editing && !saving) {
            event.preventDefault()
            toggleIdentity()
            pencil.current?.focus()
          }
        }}>
        <div className="personal-profile-identity-fields" id={`${id}-identity-fields`}>
          <input ref={loginInput} className="personal-profile-identity-login" type="text" name="login"
            aria-label="Логин" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64}
            readOnly={!editing || !!saving} tabIndex={editing ? 0 : -1} value={identity?.login ?? user.login}
            onChange={event => changeIdentity('login', event.target.value)}/>
          <input className="personal-profile-identity-name" type="text" name="name"
            aria-label="Имя в CRM" autoComplete="name" maxLength={120} readOnly={!editing || !!saving}
            tabIndex={editing ? 0 : -1} value={identity?.name ?? user.name} onChange={event => changeIdentity('name', event.target.value)}/>
        </div>
        <div className="personal-profile-identity-actions">
          <button type="button" ref={pencil} className="icon-button personal-profile-pencil" aria-expanded={editing} aria-controls={`${id}-identity-fields`}
            aria-label={editing ? 'Отменить редактирование' : 'Изменить имя и логин'}
            title={editing ? 'Отменить редактирование' : 'Изменить имя и логин'} aria-disabled={!!saving} onClick={toggleIdentity}>
            {editing ? <X size={16} aria-hidden="true"/> : <Pencil size={16} aria-hidden="true"/>}
          </button>
          {editing && <button type="submit" className="icon-button personal-profile-identity-save" disabled={!!saving || !identityChanged}
            aria-label={saving === 'identity' ? 'Сохраняем…' : 'Сохранить'} title="Сохранить имя и логин">
            <Check size={18} aria-hidden="true"/>
          </button>}
        </div>
        {renderFeedback('identity')}
      </form>
    </ProfileAvatarPicker>
    <form className="personal-profile-form" aria-labelledby={`${id}-password-title`} aria-busy={saving === 'password'} onSubmit={submitPassword}>
      <h3 id={`${id}-password-title`}>Сменить пароль</h3>
      <p className="personal-profile-session-note">После смены пароля на других устройствах потребуется войти снова. Текущий сеанс останется открытым.</p>
      <input className="personal-profile-login" name="username" autoComplete="username" value={user.login} readOnly tabIndex={-1} aria-hidden="true"/>
      <label className="personal-profile-field" htmlFor={`${id}-current`}>
        Текущий пароль
        <input id={`${id}-current`} name="current-password" type="password" autoComplete="current-password" maxLength={256}
          value={passwords.currentPassword} required disabled={!!saving} onChange={event => setPassword('currentPassword', event.target.value)}/>
      </label>
      <label className="personal-profile-field" htmlFor={`${id}-new`}>
        Новый пароль
        <input id={`${id}-new`} name="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={256}
          aria-describedby={`${id}-length`} value={passwords.newPassword} required disabled={!!saving}
          onChange={event => setPassword('newPassword', event.target.value)}/>
      </label>
      <p className="personal-profile-hint" id={`${id}-length`}>От 12 до 256 символов.</p>
      <label className="personal-profile-field" htmlFor={`${id}-repeat`}>
        Повторите новый пароль
        <input ref={repeatInput} id={`${id}-repeat`} name="repeated-password" type="password" autoComplete="new-password" maxLength={256}
          value={passwords.repeatedPassword} required disabled={!!saving} aria-invalid={mismatch}
          aria-describedby={mismatch ? `${id}-mismatch` : undefined}
          onChange={event => setPassword('repeatedPassword', event.target.value)}/>
      </label>
      {mismatch && <p className="personal-profile-feedback personal-profile-mismatch" id={`${id}-mismatch`} role="status">Пароли не совпадают.</p>}
      <button type="submit" className="button primary" disabled={!!saving}>
        {saving === 'password' ? 'Сохраняем…' : 'Сохранить пароль'}
      </button>
      {renderFeedback('password')}
    </form>
  </div>
}
