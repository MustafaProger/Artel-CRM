import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** Retain native summary keyboard behavior; keep content mounted until closing finishes. */
export default function AnimatedDetails({ summary, children, className, testId }: {
  summary: ReactNode; children: ReactNode; className: string; testId?: string
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const animation = useRef<Animation | null>(null)
  const targetOpen = useRef(false)
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  useEffect(() => () => { animation.current?.cancel() }, [])

  const toggle = () => {
    const element = ref.current!
    const heading = element.querySelector('summary')!
    const start = element.getBoundingClientRect().height
    if (animation.current) {
      animation.current.onfinish = null
      animation.current.cancel()
    }
    const next = !targetOpen.current
    targetOpen.current = next
    setExpanded(next)
    // Native details must stay open while its height shrinks.
    element.open = true
    const end = next ? element.getBoundingClientRect().height : heading.getBoundingClientRect().height
    const finish = () => {
      element.open = next
      element.style.removeProperty('overflow')
      animation.current = null
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return }
    element.style.overflow = 'hidden'
    const active = element.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)',
    })
    animation.current = active
    active.onfinish = finish
  }

  return <details ref={ref} className={className} data-testid={testId} data-expanded={expanded}>
    <summary aria-expanded={expanded} aria-controls={contentId} onClick={event => { event.preventDefault(); toggle() }}>{summary}</summary>
    <div id={contentId} className="animated-details-content" inert={!expanded}>{children}</div>
  </details>
}
