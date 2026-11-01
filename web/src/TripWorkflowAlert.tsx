import type { TripWorkflowIssue } from './trip-workflow-issues'
import './trip-workflow-alert.css'
export function tripIssueLabel(issues: TripWorkflowIssue[]) {
  if (issues.some(issue => /не заполн|не указан|недоста|дополн|заполните/i.test(issue.message))) return 'Дополнить данные'
  if (issues.some(issue => /нет связи|соединени|сервер не ответ|тайм-аут/i.test(issue.message))) return 'Проверить связь'
  if (issues.some(issue => /подпис/i.test(issue.message))) return 'Проверить подпись'
  return issues.length ? `Проверить этап ${issues[0].step + 1}` : ''
}
export function TripIssueLabel({ issues }: { issues: TripWorkflowIssue[] }) {
  return issues.length ? <span className="trip-issue-label">{tripIssueLabel(issues)}</span> : null
}
export default function TripWorkflowAlert({ issues }: { issues: TripWorkflowIssue[] }) {
  if (!issues.length) return null
  return <div className="trip-workflow-alert" aria-label="Ошибки обработки ЭТрН"><div><strong>Требуется внимание</strong><ul>{issues.map((issue, index) => <li key={index}><b>{issue.stage}</b>{issue.shipmentId ? ' · ЭТрН доставки' : ''}: {issue.message}</li>)}</ul></div></div>
}
