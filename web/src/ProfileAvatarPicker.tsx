import { Plus } from 'lucide-react'
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import type { AccountUser } from './auth-model'
import { avatarPresetIds, avatarPresetUrl, type AvatarPresetId } from './avatar-model'
import { prepareAvatarImage } from './profile-avatar-image'
import UserAvatar from './UserAvatar'
import './profile-avatar-picker.css'

const avatarNames = {
  'preset-01': 'Горы', 'preset-02': 'Солнце', 'preset-03': 'Луна', 'preset-04': 'Планета',
  'preset-05': 'Комета', 'preset-06': 'Орбита', 'preset-07': 'Созвездие', 'preset-08': 'Маяк',
  'preset-09': 'Волна', 'preset-10': 'Капля', 'preset-11': 'Снежинка', 'preset-12': 'Вулкан',
  'preset-13': 'Северное сияние', 'preset-14': 'Облако', 'preset-15': 'Молния', 'preset-16': 'Кристалл',
  'preset-17': 'Лабиринт', 'preset-18': 'Куб', 'preset-19': 'Кольца', 'preset-20': 'Мозаика',
  'preset-21': 'Спираль', 'preset-22': 'Компас', 'preset-23': 'Часы', 'preset-24': 'Звезда',
  'preset-25': 'Пирамида', 'preset-26': 'Парус', 'preset-27': 'Воздушный змей', 'preset-28': 'Галактика',
  'preset-29': 'Фонарь', 'preset-30': 'Радуга',
} satisfies Record<AvatarPresetId, string>

export default function ProfileAvatarPicker({ user, busy, saving, onSave, feedback, children }: {
  user: AccountUser
  busy: boolean
  saving?: boolean
  onSave: (value: string | null | (() => Promise<string>)) => void
  feedback?: ReactNode
  children?: ReactNode
}) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onSave(() => prepareAvatarImage(file))
  }

  return <div className="profile-avatar-picker" role="group" aria-label="Аватар профиля" aria-busy={!!saving}
    onKeyDown={event => {
      if (event.defaultPrevented || event.key !== 'Escape' || !open) return
      event.preventDefault()
      setOpen(false)
      toggle.current?.focus()
    }}>
    <div className="profile-avatar-identity">
      <div className="profile-avatar-anchor">
        <UserAvatar name={user.name} avatarUrl={user.avatarUrl} size={64}/>
        <button ref={toggle} type="button" className="profile-avatar-toggle" aria-label="Изменить аватар"
          aria-expanded={open} aria-controls={id}
          onClick={() => { setOpened(true); setOpen(value => !value) }}>
          <span><Plus size={15} aria-hidden="true"/></span>
        </button>
      </div>
      <div className="profile-avatar-identity-fields">{children}</div>
    </div>
    <div className="profile-avatar-expansion" data-open={open} inert={!open}>
      <div className="profile-avatar-clip">
        <div id={id} className="profile-avatar-gallery" role="group" aria-label="Выбор аватара">
          {opened && <>
            <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf"
              aria-label="Файл аватара" disabled={busy} onChange={upload}/>
            <div className="profile-avatar-grid">
              <button type="button" className="profile-avatar-choice profile-avatar-upload" aria-label="Загрузить аватар"
                title="Загрузить аватар" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Plus size={19} aria-hidden="true"/>
              </button>
              {avatarPresetIds.map(preset => <button key={preset} type="button" className="profile-avatar-choice"
                aria-pressed={user.avatarPreset === preset} aria-label={avatarNames[preset]} title={avatarNames[preset]} disabled={busy}
                onClick={() => { if (preset !== user.avatarPreset) onSave(preset) }}>
                <img src={avatarPresetUrl(preset)} alt="" width={36} height={36} decoding="async"/>
              </button>)}
            </div>
            {user.avatarUrl && <div className="profile-avatar-actions">
              <button type="button" className="button" disabled={busy} onClick={() => onSave(null)}>Удалить аватар</button>
            </div>}
          </>}
        </div>
      </div>
    </div>
    {saving && <p className="profile-avatar-status" role="status">Сохраняем аватар…</p>}
    {feedback}
  </div>
}
