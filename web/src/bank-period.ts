export const bankToday = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now)

// A calendar month is always within the bank's inclusive 31-day limit.
export function defaultBankPeriod(now = new Date()) {
  const to = bankToday(now)
  return { from: `${to.slice(0, 7)}-01`, to }
}

export function bankPeriodError({ from, to }: { from: string; to: string }, today = bankToday()) {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  if (!valid(from) || !valid(to)) return 'Выберите начало и конец периода.'
  if (from > to) return 'Начало периода должно быть не позднее его окончания.'
  if (to > today) return 'Выписки доступны по текущую дату. Будущие даты выбрать нельзя.'
  if (Date.parse(to) - Date.parse(from) > 30 * 86400000) return 'Выберите период не более 31 дня.'
  return ''
}
