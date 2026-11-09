import { OperationsStore } from '../server/operations-store';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = process.argv[2];
assert(directory && process.argv[3] === '--create-100-demo-tasks');
const pointer = JSON.parse(await readFile(`${directory}/operations.json`, 'utf8'));
assert.equal(pointer.format, 'artel-auth-partition-v2');
const store = new OperationsStore(directory);
const prefix = 'work-tasks-demo-20261109-';
console.log(JSON.stringify(await store.mutateWork(pointer.sourceSha256, data => {
  const existing = data.work?.tasks.filter(task => task.id.startsWith(prefix)) ?? [];
  if (existing.length) { assert.equal(existing.length, 100); return { changed: false, result: { created: 0, existing: 100 } }; }
  const users = data.accounts!.users.filter(user => user.active && !user.deletedAt && user.role !== 'driver' && user.sections.includes('work'));
  assert(users.length >= 2);
  const actor = users.find(user => user.role === 'director')!; assert(actor);
  const actions = ['Проверить документы', 'Согласовать поставку', 'Подготовить сверку', 'Уточнить адрес', 'Проверить реквизиты', 'Обновить план', 'Связаться с клиентом', 'Сверить объёмы', 'Подготовить отчёт', 'Проверить маршрут'];
  const offsets = [-45, -20, -7, -1, 0, 1, 7, 20, 45, null];
  const now = new Date().toISOString();
  const tasks = Array.from({length: 100}, (_, i) => {
    const status = (['todo', 'doing', 'done'] as const)[i % 3];
    const offset = offsets[Math.floor(i / 10)];
    const dueDate = offset === null ? null : new Date(Date.UTC(2026, 10, 9 + offset)).toISOString().slice(0,10);
    return { id: `${prefix}${String(i + 1).padStart(3,'0')}`, version: 1, title: `[ТЕСТ ${String(i + 1).padStart(3,'0')}] ${actions[i % 10]}`, description: `Демонстрационная задача по поручению владельца CRM. Создана техническим импортом 09.11.2026. Сценарий: ${dueDate ? 'срок ' + dueDate : 'без срока'}. Не является рабочим поручением.`, assigneeId: users[i % users.length].id, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now, status, archivedAt: status === 'done' ? now : null, companyId: null, dueDate, reminderAt: null, comments: [], attachments: [] };
  });
  data.work ??= {tasks: [], companyRecords: [], notes: []};
  data.work.tasks.push(...tasks);
  return {changed: true, result: {created: tasks.length, assignees: users.length, todo: 34, doing: 33, done: 33}};
})));
