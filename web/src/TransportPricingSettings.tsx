import { useRef, useState } from 'react'
import { LoaderCircle, Pencil, Save } from 'lucide-react'
import { apiFetch } from './workspace-api'
import { readTransportPricing, validTransportPricing, type TransportPricingSettings as Pricing, type TransportRounding } from './transport-pricing'
import './transport-settings.css'

const rubles = (value: string) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const normalize = (value: string) => value.replace(/\s/g, '').replace(',', '.')

export default function TransportPricingSettings({ value, canManage, onChanged }: { value?: Pricing; canManage: boolean; onChanged: () => void | Promise<void> }) {
  const [saved, setSaved] = useState<Pricing | null>(null)
  const current = saved && saved.version > (value?.version ?? 0) ? saved : readTransportPricing(value)
  const [draft, setDraft] = useState<Pricing | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const lock = useRef(false)
  const begin = () => { setDraft({ ...current }); setError(''); setNotice(''); setConflict(false) }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft || lock.current || !canManage || conflict) return
    const next = { ...draft, ratePerKmRub: normalize(draft.ratePerKmRub), customerSurchargeRub: normalize(draft.customerSurchargeRub) }
    if (!validTransportPricing(next)) { setError('Укажите обе ставки: от 0 до 999 999 999,99 ₽, не более двух знаков после запятой.'); return }
    lock.current = true; setSaving(true); setError(''); setNotice('')
    try {
      const response = await apiFetch('/api/transport-pricing', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next), signal: AbortSignal.timeout(15000) })
      const result = await response.json()
      if (!response.ok) { if (response.status === 409) setConflict(true); throw new Error(result.error || 'Не удалось сохранить тарифы.') }
      if (!validTransportPricing(result.transportPricing)) throw new Error('Ответ сервера не содержит сохранённые тарифы. Обновите справочник и проверьте значения.')
      setSaved(result.transportPricing); setDraft(null); setNotice('Тарифы сохранены. Суммы в сохранённых рейсах не изменились.')
      try { await onChanged() } catch { setNotice('Тарифы сохранены. Обновите справочник, чтобы увидеть их во всех формах.') }
    } catch (reason) { setError(reason instanceof Error && !['TimeoutError', 'AbortError', 'TypeError'].includes(reason.name) ? reason.message : 'Ответ сервера не получен. Обновите справочник и проверьте, сохранились ли тарифы, прежде чем повторять изменение.') }
    finally { lock.current = false; setSaving(false) }
  }
  const reload = async () => {
    if (lock.current) return
    lock.current = true; setSaving(true); setError('')
    try { await onChanged(); setDraft(null); setConflict(false); setNotice('Справочник обновлён. Откройте изменение тарифов ещё раз.') }
    catch { setError('Не удалось обновить справочник. Повторите загрузку.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <section className="panel transport-settings" aria-labelledby="transport-settings-title">
    <div className="transport-settings-heading"><div><h2 id="transport-settings-title">Тарифы перевозки</h2><p>Общие ставки для всех клиентов</p></div>{canManage && !draft && <button type="button" className="button" onClick={begin}><Pencil size={16} aria-hidden="true"/>Изменить тарифы</button>}</div>
    {draft && canManage ? <form onSubmit={save}>
      <div className="transport-settings-fields">
        <label className="shipment-field"><span>Ставка за километр, ₽/км</span><input inputMode="decimal" maxLength={32} required value={draft.ratePerKmRub} disabled={saving || conflict} onChange={event => setDraft({ ...draft, ratePerKmRub: event.target.value })}/></label>
        <label className="shipment-field"><span>Доплата за клиента, ₽</span><input inputMode="decimal" maxLength={32} required value={draft.customerSurchargeRub} disabled={saving || conflict} onChange={event => setDraft({ ...draft, customerSurchargeRub: event.target.value })}/></label>
        <label className="shipment-field"><span>Округление итога</span><select value={draft.rounding} disabled={saving || conflict} onChange={event => setDraft({ ...draft, rounding: event.target.value as TransportRounding })}><option value="nearest100">До ближайших 100 ₽</option><option value="ceil100">Вверх до 100 ₽</option></select></label>
      </div>
      <p className="directory-pricing-hint">Округление: {draft.rounding === 'ceil100' ? 'вверх до 100 ₽' : 'до ближайших 100 ₽, половина вверх'}. Округление применяется один раз к итогу каждого клиента.</p>
      <div className="transport-settings-actions"><button className="button primary" type="submit" disabled={saving || conflict}>{saving ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <Save size={16} aria-hidden="true"/>}Сохранить тарифы</button><button type="button" className="button" disabled={saving} onClick={() => { setDraft(null); setError(''); setConflict(false) }}>Отмена</button>{conflict && <button type="button" className="button" disabled={saving} onClick={() => void reload()}>Загрузить актуальные тарифы</button>}</div>
    </form> : <div className="transport-settings-summary"><strong>{rubles(current.ratePerKmRub)} ₽/км</strong><span>+</span><strong>{rubles(current.customerSurchargeRub)} ₽ за клиента</strong><span>+ стоимость назначенных секций</span></div>}
    {!draft && <p className="directory-pricing-hint">Итог каждого клиента: {current.rounding === 'ceil100' ? 'вверх до 100 ₽' : 'до ближайших 100 ₽, половина вверх'}.</p>}
    <p className="directory-pricing-hint">Новые тарифы используются в новых расчётах. Сохранённые рейсы и ручные суммы автоматически не пересчитываются.</p>
    {error && <p className="shipment-error" role="alert">{error}</p>}{notice && <p className="directory-notice" role="status">{notice}</p>}
  </section>
}
