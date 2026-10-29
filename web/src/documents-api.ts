import { apiFetch } from './workspace-api'
export async function documentsRequest<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await apiFetch(`/api/documents${path}`, { cache: 'no-store', method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Не удалось сохранить. Введённые данные остались в форме.')
  return data
}
