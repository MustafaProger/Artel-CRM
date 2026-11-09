import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OperationsStore } from '../server/operations-store';
import type { WorkTask } from '../web/src/work-model';

const [directory, confirmation] = process.argv.slice(2);
assert(directory && confirmation === '--writers-stopped');
const pointer = JSON.parse(await readFile(`${directory}/operations.json`, 'utf8'));
assert.equal(pointer.format, 'artel-auth-partition-v2');
const store = new OperationsStore(directory);
const oldBatch = /^work-tasks-demo-20261109-\d{3}$/;
const newBatch = /^work-tasks-demo-20261109-refresh-\d{2}$/;
const titles = [
  'Сверить заявку на доставку', 'Подготовить список документов', 'Проверить маршрут рейса',
  'Уточнить окно погрузки', 'Сравнить тарифы доставки', 'Обновить карточку компании',
  'Проверить данные машины', 'Сверить объём поставки', 'Проверить адрес разгрузки',
  'Подготовить недельный план', 'Сверить реестр рейсов', 'Проверить комплектность архива',
  'Распределить заявки по датам', 'Уточнить время подачи', 'Проверить сумму счёта',
  'Подготовить отчёт по рейсам', 'Проверить остатки по секциям', 'Сверить статусы отгрузок',
  'Составить список вопросов', 'Проверить итоговую сводку',
];
const proof = await store.mutateWork(pointer.sourceSha256, data => {
  assert(data.work);
  const old = data.work.tasks.filter(task => oldBatch.test(task.id));
  assert.equal(old.length, 100, 'Unexpected legacy demo batch');
  assert(old.every(task => /^\[ТЕСТ \d{3}\]/.test(task.title) && !task.attachments.length));
  assert(!data.work.tasks.some(task => newBatch.test(task.id)), 'Replacement batch already exists');
  const retained = data.work.tasks.filter(task => !oldBatch.test(task.id));
  const users = data.accounts!.users.filter(user => user.active && !user.deletedAt && user.role !== 'driver' && user.sections.includes('work'));
  const actor = users.find(user => user.role === 'director');
  assert(actor);
  const now = new Date().toISOString();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(now));
  const tasks: WorkTask[] = titles.map((title, i) => {
    const number = String(i + 1).padStart(2, '0');
    const status = i < 8 ? 'todo' : i < 15 ? 'doing' : 'done';
    const date = new Date(today + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + (i % 7) - 2);
    return {
      id: `work-tasks-demo-20261109-refresh-${number}`, version: 1, title: `[ТЕСТ ${number}] ${title}`,
      description: 'Демонстрационная задача для проверки CRM. Не является рабочим поручением.',
      assigneeId: users[i % users.length].id, createdBy: actor.id, updatedBy: actor.id,
      createdAt: now, updatedAt: now, status, archivedAt: status === 'done' ? now : null,
      companyId: null, dueDate: i % 5 === 4 ? null : date.toISOString().slice(0, 10),
      reminderAt: null, priority: (i % 4 + 1) as WorkTask['priority'], comments: [], attachments: [],
    };
  });
  data.work.tasks = [...retained, ...tasks];
  return { changed: true, result: { removed: old.length, created: tasks.length, retained: retained.length, work: JSON.stringify(data.work) } };
});
const persisted = await store.read(pointer.sourceSha256);
assert.equal(JSON.stringify(persisted.work), proof.work);
console.log(JSON.stringify({ removed: proof.removed, created: proof.created, retained: proof.retained }));
