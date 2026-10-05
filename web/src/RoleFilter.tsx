import ScrollableSegments from './ScrollableSegments'
import { roleNames, type AccountRole } from './auth-model'
import './role-filter.css'
export type RoleFilterValue = AccountRole | 'all' | 'none'
export default function RoleFilter({ value, onChange, counts, includeUnlinked = false, disabled = false }: { value: RoleFilterValue; onChange: (value: RoleFilterValue) => void; counts: Partial<Record<RoleFilterValue, number>>; includeUnlinked?: boolean; disabled?: boolean }) {
  const options = [['all', 'Все'], ...Object.entries(roleNames), ...(includeUnlinked ? [['none', 'Без учётной записи']] : [])] as [RoleFilterValue, string][]
  return <ScrollableSegments className="account-role-filters" label="Фильтр по полномочиям" value={value}>{options.map(([role, title]) => <button type="button" key={role} disabled={disabled} aria-pressed={value === role} onClick={() => onChange(role)}>{title}{!disabled&&<span>{counts[role] ?? 0}</span>}</button>)}</ScrollableSegments>
}
