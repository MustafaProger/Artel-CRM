import { useLayoutEffect, useRef } from 'react'

/** Replay only when the selected view changes, keeping mounted controls and scroll positions intact. */
export function useViewEntrance<T extends HTMLElement>(view: string, selector?: string, offset = 0) {
  const ref = useRef<T>(null)
  const previous = useRef(view)

  useLayoutEffect(() => {
    const changed = previous.current !== view
    previous.current = view
    const surface = ref.current
    if (!changed || !surface || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const styles = getComputedStyle(surface)
    const targets = selector ? Array.from(surface.querySelectorAll(selector)).slice(0, 12) : [surface]
    const frames = offset
      ? [{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'translateY(0)' }]
      : [{ opacity: .35 }, { opacity: 1 }]
    const animations = targets.map((target, index) => target.animate(frames, {
      id: 'view-entrance',
      duration: Number.parseFloat(styles.getPropertyValue('--motion-feedback')),
      easing: styles.getPropertyValue('--motion-ease').trim(),
      delay: Math.min(index * 30, 120),
      fill: 'backwards',
    }))
    return () => animations.forEach(animation => animation.cancel())
  }, [view, selector, offset])

  return ref
}
