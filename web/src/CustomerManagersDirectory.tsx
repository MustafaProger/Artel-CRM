import { useState } from 'react'
import { LoaderCircle, Save, Search } from 'lucide-react'
import type { Snapshot } from './model'
import DirectorySelect from './DirectorySelect'
import { customerManagerId } from './customer-manager'

export default function CustomerManagersDirectory({ data, onChanged }: { data: Snapshot; onChanged: () => void }) {
  const catalog = data.directories!
  const [companyId, setCompanyId] = useState('')
  const [managerId, setManagerId] = useState('')
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const selectCompany = (id: string) => {
    setCompanyId(id)
    setManagerId(customerManagerId(catalog, id))
    setError(''); setNotice('')
  }
  const save = async (remove = false) => {
    if (saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/directories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'customerManagers', companyId, managerId: remove ? null : managerId }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить назначение')
      if (remove) setManagerId('')
      setNotice(remove ? 'Назначение снято' : 'Менеджер клиента сохранён')
      onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
    finally { setSaving(false) }
  }
  const rows = (catalog.customerManagers ?? []).map(row => ({
    ...row, company: data.companies.find(company => company.id === row.companyId),
    manager: catalog.managers.find(manager => manager.id === row.managerId),
  })).filter(row => `${row.company?.name} ${row.company?.inn ?? ''} ${row.manager?.name}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
    .sort((a, b) => (a.company?.name ?? '').localeCompare(b.company?.name ?? '', 'ru'))
  return <>
    <form className="panel directory-create" onSubmit={event => { event.preventDefault(); void save() }}>
      <h2>Клиенты и менеджеры</h2>
      <p className="shipment-editor-note">Укажите менеджера клиента по вашей таблице. При выборе клиента в отгрузке менеджер подставится автоматически. Сохранённые отгрузки сохранят своих менеджеров.</p>
      <div className="shipment-field-grid">
        <DirectorySelect label="Клиент" entries={data.companies.map(company => ({ id: company.id, name: company.name, detail: company.inn }))} value={companyId} onChange={selectCompany} required disabled={saving}/>
        <DirectorySelect label="Менеджер клиента" entries={catalog.managers} value={managerId} onChange={setManagerId} required disabled={saving}/>
      </div>
      <div className="directory-assignment-actions">
        <button className="button primary" type="submit" disabled={saving || !companyId || !managerId}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>}Сохранить назначение</button>
        {customerManagerId(catalog, companyId) && <button className="button" type="button" disabled={saving} onClick={() => void save(true)}>Снять назначение</button>}
      </div>
    </form>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {notice && <p className="soft-notice" role="status">{notice}</p>}
    <section className="panel directory-list">
      <label className="shipment-search"><Search size={17}/><input aria-label="Поиск клиентов и менеджеров" placeholder="Клиент, ИНН или менеджер…" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <p className="shipment-editor-note">Назначений: {rows.length}</p>
      <div className="directory-assignment-scroll"><table className="directory-assignment-table" aria-label="Клиенты и менеджеры"><thead><tr><th>Клиент</th><th>Менеджер</th><th>Действие</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.companyId}><td>{row.company?.name}{row.company?.inn && <small>ИНН {row.company.inn}</small>}</td><td>{row.manager?.name}</td><td><button className="button" disabled={saving} onClick={() => selectCompany(row.companyId)}>Изменить</button></td></tr>)}
      </tbody></table></div>
      {!rows.length && <p className="shipment-editor-note">{query ? 'Ничего не найдено.' : 'Добавьте связи из таблицы клиентов и менеджеров.'}</p>}
    </section>
  </>
}
