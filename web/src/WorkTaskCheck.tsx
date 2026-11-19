import { Check, X } from 'lucide-react';
import type { WorkStatus, WorkTask } from './work-model';

export default function WorkTaskCheck({ task, status = task.status, disabled, onToggle }: {
  task: WorkTask; status?: WorkStatus; disabled: boolean; onToggle: () => void;
}) {
  if (status === 'failed') {
    return <button type="button" className="work-task-check work-task-reopen" aria-label={`Вернуть в работу: ${task.title}`}
      title="Вернуть в работу" disabled={disabled} onClick={onToggle}>
      <span className="work-task-check-box" aria-hidden="true"><X size={15} strokeWidth={2.5}/></span>
    </button>;
  }
  return <label className={`work-task-check work-priority-${task.priority ?? 4}`} title={status === 'done' ? 'Вернуть в работу' : 'Выполнить задачу'}>
    <input type="checkbox" aria-label={`Выполнена: ${task.title}`} checked={status === 'done'} disabled={disabled} onChange={onToggle}/>
    <span className="work-task-check-box" aria-hidden="true"><Check size={12} strokeWidth={2.5}/></span>
  </label>;
}
