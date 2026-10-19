import { useCallback, useEffect, useRef, type RefObject } from 'react'
import './modal-motion.css'

let scrollLocks = 0
let restoreScroll: (() => void) | undefined

export function lockPageScroll() {
  if (scrollLocks++ === 0) {
    const body = document.body.style, root = document.documentElement.style
    const overflow = body.overflow, rootOverflow = root.overflow, overscroll = root.overscrollBehavior
    body.overflow = 'hidden'
    root.overflow = 'hidden'
    root.overscrollBehavior = 'none'
    restoreScroll = () => { body.overflow = overflow; root.overflow = rootOverflow; root.overscrollBehavior = overscroll }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--scrollLocks === 0) { restoreScroll?.(); restoreScroll = undefined }
  }
}

/** Keep a native dialog in the top layer until its exit animation has finished.
 * Native Escape handling is cancelled here; each form retains its own busy/dirty guard.
 */
export function useDialogMotion(dialog: RefObject<HTMLDialogElement | null>, onDismiss?: () => void, autoOpen = true) {
  const dismiss = useRef(onDismiss)
  const mounted = useRef(false)
  const focused = useRef<HTMLElement | null>(null)
  const releaseScroll = useRef<(() => void) | undefined>(undefined)
  const pending = useRef<{ promise: Promise<void>; cancel: () => void } | null>(null)
  const openingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { dismiss.current = onDismiss }, [onDismiss])

  const restore = useCallback(() => {
    releaseScroll.current?.()
    releaseScroll.current = undefined
    if (focused.current?.isConnected) focused.current.focus({ preventScroll: true })
    focused.current = null
  }, [])

  const open = useCallback(() => {
    const element = dialog.current
    if (!element || !mounted.current) return
    // Reversing an exit starts at its current presentation instead of jumping.
    const current = element.open ? getComputedStyle(element) : null
    const opacity = current?.opacity ?? '0', transform = current?.transform
    const backdropOpacity = element.open ? getComputedStyle(element, '::backdrop').opacity : '0'
    pending.current?.cancel()
    pending.current = null
    clearTimeout(openingTimer.current)
    element.inert = false
    element.style.setProperty('--modal-enter-opacity', opacity)
    element.style.setProperty('--modal-backdrop-enter-opacity', backdropOpacity)
    if (transform) element.style.setProperty('--modal-enter-transform', transform)
    else element.style.removeProperty('--modal-enter-transform')
    if (!element.open) {
      focused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      releaseScroll.current = lockPageScroll()
      element.dataset.modalMotion = 'opening'
      element.showModal()
    } else element.dataset.modalMotion = 'opening'
    openingTimer.current = setTimeout(() => {
      if (element.dataset.modalMotion === 'opening') element.dataset.modalMotion = 'open'
    }, 260)
  }, [dialog])

  const complete = useCallback((callback: () => void | Promise<void>): Promise<void> => {
    if (pending.current) return pending.current.promise
    const element = dialog.current
    if (!mounted.current || !element) return Promise.resolve()
    clearTimeout(openingTimer.current)
    const current = getComputedStyle(element)
    element.style.setProperty('--modal-exit-opacity', current.opacity)
    element.style.setProperty('--modal-exit-transform', current.transform)
    element.style.setProperty('--modal-backdrop-exit-opacity', getComputedStyle(element, '::backdrop').opacity)
    element.inert = true
    element.dataset.modalMotion = 'closing'
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const styles = getComputedStyle(element)
    const seconds = (value: string) => value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000
    const duration = styles.animationName === 'none' || reduced ? 0 : Math.max(...styles.animationDuration.split(',').map(seconds))
    let stop = () => {}
    const animation = new Promise<boolean>(resolve => {
      let settled = false
      const finish = (run: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        element.removeEventListener('animationend', ended)
        resolve(run)
      }
      const ended = (event: AnimationEvent) => {
        if (event.target === element && !event.pseudoElement && event.animationName === 'modal-exit') finish(true)
      }
      const timer = setTimeout(() => finish(true), duration ? duration + 80 : 0)
      stop = () => finish(false)
      element.addEventListener('animationend', ended)
    })
    const promise = animation.then(async run => {
      if (!run || !mounted.current) return
      element.close()
      element.inert = false
      delete element.dataset.modalMotion
      restore()
      try { await callback() }
      catch (reason) { if (mounted.current) open(); throw reason }
    }).finally(() => { if (pending.current?.promise === promise) pending.current = null })
    pending.current = { promise, cancel: stop }
    return promise
  }, [dialog, open, restore])

  const close = useCallback(() => {
    // A delayed notification permission response may arrive after its menu closed.
    if (dialog.current?.open) void complete(() => dismiss.current?.())
  }, [complete, dialog])

  useEffect(() => {
    mounted.current = true
    const element = dialog.current
    const preventNativeClose = (event: Event) => event.preventDefault()
    element?.addEventListener('cancel', preventNativeClose)
    if (autoOpen) open()
    return () => {
      mounted.current = false
      pending.current?.cancel()
      pending.current = null
      clearTimeout(openingTimer.current)
      element?.removeEventListener('cancel', preventNativeClose)
      element?.close()
      if (element) { element.inert = false; delete element.dataset.modalMotion }
      restore()
    }
  }, [autoOpen, dialog, open, restore])

  return { open, close, complete }
}
