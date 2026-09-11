import { useEffect, useMemo, useRef, useState } from 'react'
import type { ShipmentColumn } from './shipment-templates'

const storageKey = 'artel:shipment-column-widths:v1'
const desktopQuery = '(min-width: 1100px) and (hover: hover) and (pointer: fine)'
const minWidth = 64, maxWidth = 640
const clamp = (width: number) => Math.max(minWidth, Math.min(maxWidth, Math.round(width)))
type Preferences = Record<string, Record<string, number>>

function readPreferences(): Preferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter(([, fields]) => fields && typeof fields === 'object' && !Array.isArray(fields)).map(([view, fields]) => [view, Object.fromEntries(Object.entries(fields).filter(([, width]) => typeof width === 'number' && Number.isFinite(width)).map(([key, width]) => [key, clamp(width as number)]))]))
  } catch { return {} }
}

const defaultWidth = (column: ShipmentColumn) => Math.max(column.width, column.kind === 'company' ? 200 : column.kind === 'date' ? 120 : column.kind === 'inn' ? 140 : column.kind === 'number' ? 120 : column.key === 'manager_label' ? 124 : column.key === 'payment_form' ? 120 : 88)

export function useShipmentColumnWidths(view: string, original: ShipmentColumn[]) {
  const [enabled, setEnabled] = useState(() => window.matchMedia(desktopQuery).matches)
  const [preferences, setPreferences] = useState(readPreferences)
  const preferencesRef = useRef(preferences)
  useEffect(() => {
    const media = window.matchMedia(desktopQuery)
    const changed = () => setEnabled(media.matches)
    changed(); media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  const columns = useMemo(() => enabled ? original.map(column => ({ ...column, width: preferences[view]?.[column.key] ?? defaultWidth(column) })) : original, [enabled, original, preferences, view])
  const resize = (key: string, width: number | null, persist: boolean) => {
    const fields = { ...preferencesRef.current[view] }
    if (width === null) delete fields[key]; else fields[key] = clamp(width)
    const next = { ...preferencesRef.current, [view]: fields }
    preferencesRef.current = next; setPreferences(next)
    if (persist) { try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Widths still work for this session. */ } }
  }
  const reset = () => {
    const next = { ...preferencesRef.current }; delete next[view]
    preferencesRef.current = next; setPreferences(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Optional preference. */ }
  }
  return { columns, enabled, resize, reset, customized: !!Object.keys(preferences[view] ?? {}).length }
}

export default function ShipmentColumnResize({ column, onResize }: { column: ShipmentColumn; onResize: (key: string, width: number | null, persist: boolean) => void }) {
  const drag = useRef<{ pointer: number; x: number; width: number; latest: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return <div className={`shipment-column-resize${dragging ? ' is-dragging' : ''}`} role="separator" aria-orientation="vertical" aria-label={`Ширина столбца: ${column.title}`} aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={column.width} aria-valuetext={`${column.width} пикселей`} tabIndex={0}
    title="Потяните границу, чтобы изменить ширину. Двойной щелчок — сброс."
    onPointerDown={event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointer: event.pointerId, x: event.clientX, width: column.width, latest: column.width }; setDragging(true)
    }}
    onPointerMove={event => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      current.latest = clamp(current.width + event.clientX - current.x)
      onResize(column.key, current.latest, false)
    }}
    onPointerUp={event => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      onResize(column.key, current.latest, true)
      drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onLostPointerCapture={() => {
      if (drag.current) onResize(column.key, drag.current.width, true)
      drag.current = null; setDragging(false)
    }}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onResize(column.key, null, true) }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      onResize(column.key, event.key === 'Enter' ? null : event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : column.width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10), true)
    }}/>
}
