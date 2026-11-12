import { useState } from 'react'
import './user-avatar.css'

export default function UserAvatar({ name, avatarUrl, size = 18, className }: {
  name: string
  avatarUrl?: string | null
  size?: number
  className?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string>()
  const initial = name.match(/\p{L}\p{M}*/u)?.[0].toLocaleUpperCase('ru') || '?'
  return (
    <span className={['user-avatar', className].filter(Boolean).join(' ')} aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * .48) }}>
      <span>{initial}</span>
      {avatarUrl && avatarUrl !== failedUrl && <img
        key={avatarUrl} src={avatarUrl} alt="" width={size} height={size} decoding="async"
        onError={() => setFailedUrl(avatarUrl)}
      />}
    </span>
  )
}
