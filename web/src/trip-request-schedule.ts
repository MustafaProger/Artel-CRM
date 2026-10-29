import type { TripRequest } from './trip-request-model';

export function validRequestDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}

const moscowDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
export const requestToday = (now = new Date()) => moscowDay.format(now);
export function requestMapDays(now = new Date()) {
  const today = requestToday(now);
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return [today, next.toISOString().slice(0, 10)];
}
export function requestIsOnMap(request: Pick<TripRequest, 'status' | 'executionDate'>, now = new Date()) {
  return request.status === 'active' && !!request.executionDate && requestMapDays(now).includes(request.executionDate);
}
export function compareRequestDates(a: TripRequest, b: TripRequest) {
  return (a.executionDate || '9999-99-99').localeCompare(b.executionDate || '9999-99-99') || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}
export const requestDateLabel = (value?: string | null) => value ? value.split('-').reverse().join('.') : 'Не указана';
