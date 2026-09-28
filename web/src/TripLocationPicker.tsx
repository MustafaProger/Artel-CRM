import { useState } from 'react'
import { MapPin, Plus } from 'lucide-react'
import type { ShipmentAddress } from './model'
import DirectorySelect from './DirectorySelect'

export function safeMapUrl(value?: string | null) {
  if (!value) return null
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null } catch { return null }
}

export default function TripLocationPicker({ label, kind, companyId, value, addresses, addressSnapshot, mapSnapshot, disabled, canManage, onChange, onCreated }: {
  label: string; kind: 'loading' | 'delivery'; companyId: string; value: string; addresses: ShipmentAddress[];
  addressSnapshot?: string | null; mapSnapshot?: string | null; disabled: boolean; canManage: boolean;
  onChange: (id: string) => void; onCreated: (address: ShipmentAddress) => void;
}) {
  const [adding, setAdding] = useState(false), [name, setName] = useState(''), [address, setAddress] = useState(''), [mapUrl, setMapUrl] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const selected = addresses.find(item => item.id === value)
  const link = safeMapUrl(mapSnapshot ?? selected?.mapUrl)
  const add = async () => {
    if (busy || !name.trim() || !companyId) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/directories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'addresses', name, address, mapUrl, companyId, addressKind: kind }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить место')
      onCreated(result.entry); onChange(result.entry.id); setAdding(false); setName(''); setAddress(''); setMapUrl('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
    finally { setBusy(false) }
  }
  return <div className="trip-location-picker">
    <DirectorySelect label={label} entries={addresses.filter(item => item.companyId === companyId && item.kind === kind).map(item => ({ ...item, detail: item.address }))} value={value} onChange={onChange} disabled={disabled || busy || !companyId}/>
    {(addressSnapshot || selected) && <div className="trip-location-details"><span>{addressSnapshot ?? selected?.address ?? selected?.name}</span>{link && <a href={link} target="_blank" rel="noreferrer"><MapPin size={14}/>Яндекс.Карты</a>}</div>}
    {canManage && !adding && <button type="button" className="trip-text-button" disabled={disabled || !companyId} onClick={() => setAdding(true)}><Plus size={14}/>Новое место в справочнике</button>}
    {adding && <div className="trip-location-create">
      <label className="shipment-field"><span>Название нового места</span><input value={name} disabled={disabled || busy} maxLength={500} onChange={event => setName(event.target.value)}/></label>
      <label className="shipment-field"><span>Адрес новой площадки</span><input value={address} disabled={disabled || busy} maxLength={500} onChange={event => setAddress(event.target.value)}/></label>
      <label className="shipment-field"><span>Ссылка нового места на Яндекс.Карты</span><input type="url" value={mapUrl} disabled={disabled || busy} maxLength={2000} onChange={event => setMapUrl(event.target.value)}/></label>
      {error && <p className="shipment-error" role="alert">{error}</p>}
      <div className="trip-location-actions"><button type="button" className="button" disabled={busy} onClick={() => { setAdding(false); setError('') }}>Отмена</button><button type="button" className="button" disabled={disabled || busy || !name.trim()} onClick={() => void add()}>{busy ? 'Сохраняем…' : 'Добавить место'}</button></div>
    </div>}
  </div>
}
