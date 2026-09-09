import Decimal from 'decimal.js'
const ExactDecimal = Decimal.clone({ precision: 80 })
export const number = (value: string | number | null | undefined, digits = 0) => value == null ? '—' : new Intl.NumberFormat('ru-RU', {maximumFractionDigits: digits}).format(Number(value))
export const money = (value: string | number | null | undefined, digits = 0) => value == null ? '—' : `${number(value, digits)} ₽`
export function shortNumber(value: string | number | null | undefined) {
  if(value == null) return '—'
  const n = Number(value)
  return Math.abs(n) >= 1e9 ? `${number(n / 1e9, 2)} млрд` : Math.abs(n) >= 1e6 ? `${number(n / 1e6, 2)} млн` : Math.abs(n) >= 1e3 ? `${number(n / 1e3, 1)} тыс.` : number(n, 1)
}
export const formatDate = (value: string | null) => value ? new Date(value+'T12:00:00').toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'}) : 'Без даты'
export const monthName = (value: string, short = false) => new Date(`${value}-01T12:00:00`).toLocaleDateString('ru-RU', {month: short ? 'short' : 'long', ...(short ? {} : {year: 'numeric'})})
export const sum = (values: (string | null)[]) => values.length && values.every(v => v === null) ? null : values.reduce<Decimal>((acc, v) => v === null ? acc : acc.add(v), new ExactDecimal(0)).toString()
export const initial = (name: string) => name.replace(/ООО|ИП|АО|["«»]/gi, '').trim().slice(0, 2).toUpperCase()
export const roleName = (role: string) => ({customer:'Покупатель',supplier:'Поставщик',carrier:'Перевозчик',payment_counterparty:'Контрагент',summary_counterparty:'В сводке',summary_label:'В сводке',note:'В заметках',stock_summary:'Складская сводка',supplier_summary:'Сводка поставщика',prepayment_summary:'Сводка предоплат',unlabelled_payment_note:'В заметках выписки'}[role] || 'Контрагент')
export const descendingDate = (a: {date: string | null}, b: {date: string | null}) => (b.date || '').localeCompare(a.date || '')
export function downloadCsv(filename: string, headings: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    let s = v == null ? '' : String(v)
    if (/^[=+@\-\t\r\n]/.test(s) && typeof v !== 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  const csv = '\uFEFF' + [headings,...rows].map(row => row.map(cell).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
