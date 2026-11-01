import type { TripWorkflowIssue } from './trip-workflow-issues'
import './trip-workflow-alert.css'
export function tripIssueLabel(issues: TripWorkflowIssue[]) {
  if (issues.some(issue => /не заполн|не указан|недоста|дополн|заполните|выберите|укажите/i.test(issue.message))) return 'Дополнить данные'
  if (issues.some(issue => /нет связи|соединени|сервер не ответ|тайм-аут/i.test(issue.message))) return 'Проверить связь'
  if (issues.some(issue => /подпис/i.test(issue.message))) return 'Проверить подпись'
  return issues.length ? `Проверить этап ${issues[0].step + 1}` : ''
}
export function TripIssueLabel({ issues, onClick }: { issues: TripWorkflowIssue[]; onClick?: () => void }) {
  if (!issues.length) return null
  if (onClick) return <button type="button" className="trip-issue-label" onClick={onClick}>{tripIssueLabel(issues)}</button>
  return <span className="trip-issue-label">{tripIssueLabel(issues)}</span>
}
