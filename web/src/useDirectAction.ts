import { useRef, useState } from 'react'

/** Run an explicit button action once at a time, with feedback in its own view. */
export function useDirectAction() {
  const lock = useRef(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const run = async (id: string, action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setPending(id)
    setError('')
    try { await action() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.') }
    finally { lock.current = false; setPending(null) }
  }
  return { pending, error, run }
}
