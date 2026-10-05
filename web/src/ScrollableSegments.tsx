import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import './scrollable-segments.css'

const selectedSelector = 'button[aria-selected="true"], button[aria-pressed="true"]'

/** Native touch/trackpad scrolling; selection only scrolls this control, never the page. */
export default function ScrollableSegments({ children, className, label, value, role = 'group' }: {
  children: ReactNode; className: string; label: string; value: string; role?: 'group' | 'tablist'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef(0)
  const velocity = useRef(0)
  useLayoutEffect(() => {
    const element = ref.current!
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      const selected = element.querySelector<HTMLButtonElement>(selectedSelector)
      if (!selected) return
      element.style.setProperty('--segment-left', `${selected.offsetLeft}px`)
      element.style.setProperty('--segment-width', `${selected.offsetWidth}px`)
      element.style.setProperty('--segment-height', `${selected.offsetHeight}px`)
      element.style.setProperty('--segment-top', `${selected.offsetTop}px`)
      if (role === 'tablist') {
        element.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.tabIndex = button === selected ? 0 : -1 })
      }
      const inset = 8
      const left = selected.offsetLeft - inset
      const right = selected.offsetLeft + selected.offsetWidth + inset
      const current = element.scrollLeft
      const target = left < current ? left : right > current + element.clientWidth ? right - element.clientWidth : current
      cancelAnimationFrame(scrollFrame.current)
      const destination = Math.max(0, Math.min(target, element.scrollWidth - element.clientWidth))
      if (!element.dataset.ready || reducedMotion.matches) {
        element.scrollLeft = destination
        velocity.current = 0
        return
      }
      // A critically damped spring can reverse immediately without a queued native smooth scroll.
      let position = current, previousTime = performance.now()
      const animate = (time: number) => {
        const dt = Math.min((time - previousTime) / 1000, .032), omega = 24
        previousTime = time
        const distance = position - destination, impulse = velocity.current + omega * distance
        const decay = Math.exp(-omega * dt)
        position = destination + (distance + impulse * dt) * decay
        velocity.current = (velocity.current - omega * impulse * dt) * decay
        element.scrollLeft = position
        if (Math.abs(position - destination) < .5 && Math.abs(velocity.current) < 2) {
          element.scrollLeft = destination
          velocity.current = 0
        } else scrollFrame.current = requestAnimationFrame(animate)
      }
      scrollFrame.current = requestAnimationFrame(animate)
    }
    update()
    const frame = requestAnimationFrame(() => { element.dataset.ready = 'true' })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.querySelectorAll('button').forEach(button => observer.observe(button))
    const interrupt = () => { cancelAnimationFrame(scrollFrame.current); velocity.current = 0 }
    element.addEventListener('pointerdown', interrupt, { passive: true })
    element.addEventListener('wheel', interrupt, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(scrollFrame.current)
      observer.disconnect()
      element.removeEventListener('pointerdown', interrupt)
      element.removeEventListener('wheel', interrupt)
    }
  }, [value, role])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus({ preventScroll: true })
    buttons[next].click()
  }
  return <div ref={ref} className={`${className} scrollable-segments`} role={role} aria-label={label} onKeyDown={navigate}>
    <span className="scrollable-segments-selection" aria-hidden="true"/>
    {children}
  </div>
}
