import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { authenticateContext } from './qa-auth.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';

const root = resolve(process.env.ARTEL_WORK_QA_ROOT || resolve(import.meta.dirname, '..'));
const baseline = process.env.ARTEL_WORK_QA_BASELINE === '1';
const lagMs = 700;
const samples = 6;
const reducedMotion = process.env.ARTEL_WORK_QA_MOTION === 'normal' ? 'no-preference' : 'reduce';
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-work-speed-'));
const snapshotDirectory = resolve(temporary, 'snapshot');
const operationsDirectory = resolve(temporary, 'operations');
const report = { baseline, lagMs, samples, reducedMotion, browsers: {} };

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = quantile => sorted[Math.ceil(quantile * sorted.length) - 1];
  return { median: Math.round((sorted[2] + sorted[3]) / 2), p95: Math.round(percentile(.95)), values: values.map(Math.round) };
}

// Measure from the input event to the first animation frame with the expected DOM.
async function observe(page, event, selector, change, act) {
  await page.evaluate(({ event, selector, change }) => {
    window.workFeedback = new Promise(resolve => {
      window.addEventListener(event, () => {
        const start = performance.now();
        const sample = () => {
          const node = document.querySelector(selector);
          const matched = change === 'gone' ? !node : change === 'present' ? !!node : node?.checked === (change === 'checked');
          if (matched) resolve(performance.now() - start);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { capture: true, once: true });
    });
  }, { event, selector, change });
  const response = page.waitForResponse(result => result.request().method() === 'PATCH' && result.url().includes('/api/work/'));
  await act();
  const elapsed = await page.evaluate(() => Promise.race([window.workFeedback, new Promise((_, reject) => setTimeout(() => reject(Error('Feedback timeout')), 5000))]));
  assert.ok((await response).ok());
  return elapsed;
}

let runtime;
try {
  await writeTripsQaSnapshot(snapshotDirectory);
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await runtime.bootstrap();
  async function api(path, body) {
    const response = await fetch(runtime.base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
    const board = (await api('/api/work/boards', { requestId: randomUUID(), title: engine, memberIds: [] })).board;
    const task = (await api('/api/work/tasks', { requestId: randomUUID(), title: 'Карточка ' + engine, placement: { boardId: board.id, columnId: board.columns[0].id, version: board.version } })).entry;
    const other = (await api('/api/work/tasks', { requestId: randomUUID(), title: 'Обычная ' + engine })).entry;
    const browser = await launcher.launch();
    try {
      const context = await browser.newContext({ reducedMotion, serviceWorkers: 'block' });
      await authenticateContext(context, runtime.base, cookie);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let reads = 0, boardsStarted = 0, workReleased = 0;
      const patchVersions = [];
      let conflictPath = '';
      await page.route('**/api/work**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === 'GET') {
          reads++;
          if (path === '/api/work/boards' && !boardsStarted) boardsStarted = performance.now();
          if (path === '/api/work' && !workReleased) {
            await new Promise(done => setTimeout(done, lagMs));
            workReleased = performance.now();
          }
        }
        if (request.method() === 'PATCH') {
          if (path.includes('/boards/')) patchVersions.push(request.postDataJSON().version);
          await new Promise(done => setTimeout(done, lagMs));
          if (path === conflictPath) return route.fulfill({ status: 409, json: { error: 'Запись изменилась параллельно.' } });
        }
        await route.continue();
      });
      await page.goto(runtime.base + '/?workView=kanban#work');
      const lanes = page.locator('.kb-lane');
      await expect(lanes).toHaveCount(3);
      if (!(await lanes.locator('[data-card="' + task.id + '"]').count())) {
        await page.getByRole('combobox', { name: 'Выбрать проект' }).click();
        await page.getByRole('option', { name: engine, exact: true }).click();
      }
      const cardSelector = '[data-card="' + task.id + '"]';
      const boardBox = page.locator(cardSelector + ' input');
      await expect(boardBox).toBeEnabled();
      const initialParallel = boardsStarted > 0 && boardsStarted < workReleased;
      assert.equal(initialParallel, !baseline);
      const startReads = reads;
      const boardCheckbox = [], drag = [], taskList = [], editorOutcome = [];
      for (let n = 0; n < samples; n++) {
        boardCheckbox.push(await observe(page, 'click', cardSelector + ' input', n % 2 ? 'unchecked' : 'checked', () => boardBox.click()));
        await expect(boardBox).toBeEnabled();
      }
      const checkboxReads = reads - startReads;
      assert.equal(checkboxReads, baseline ? samples * 2 : 0);
      async function dropCard(index) {
        const transfer = await page.evaluateHandle(() => new DataTransfer());
        try {
          await page.locator(cardSelector).dispatchEvent('dragstart', { dataTransfer: transfer });
          await lanes.nth(index).dispatchEvent('dragover', { dataTransfer: transfer });
          await lanes.nth(index).dispatchEvent('drop', { dataTransfer: transfer });
        } finally { await transfer.dispose(); }
      }
      for (let n = 0; n < samples; n++) {
        const index = n % 2 ? 0 : 1;
        drag.push(await observe(page, 'drop', '.kb-lane[aria-label="' + board.columns[index].title + '"] ' + cardSelector, 'present', () => dropCard(index)));
        await expect(boardBox).toBeEnabled();
      }
      if (!baseline) {
        // Rapid drops stay visible while successive writes use the confirmed board versions.
        const seen = patchVersions.length;
        await dropCard(1); await expect(lanes.nth(1).locator(cardSelector)).toBeVisible();
        await dropCard(2); await expect(lanes.nth(2).locator(cardSelector)).toBeVisible();
        await expect(boardBox).toBeEnabled();
        assert.equal(patchVersions.length, seen + 2);
        assert.equal(patchVersions[seen + 1], patchVersions[seen] + 1);
        assert.ok((await api('/api/work/boards')).boards.find(value => value.id === board.id).columns[2].cards.some(card => card.id === task.id));
        conflictPath = '/api/work/boards/' + board.id;
        await dropCard(1); await expect(lanes.nth(1).locator(cardSelector)).toBeVisible();
        await expect(lanes.nth(2).locator(cardSelector)).toBeVisible();
        await expect(page.getByRole('alert')).toContainText('параллельно');
        conflictPath = '/api/work/tasks/' + task.id;
        await boardBox.click(); await expect(boardBox).toBeChecked();
        await expect(boardBox).not.toBeChecked(); await expect(page.getByRole('alert')).toContainText('параллельно');
        conflictPath = '';

        const oldDirectory = await api('/api/work/boards');
        let announceRead, releaseRead;
        const held = new Promise(resolve => { announceRead = resolve; });
        const release = new Promise(resolve => { releaseRead = resolve; });
        await page.route('**/api/work/boards', async route => {
          announceRead();
          await release;
          await route.fulfill({ json: oldDirectory }).catch(() => {});
        }, { times: 1 });
        await page.getByRole('button', { name: 'Обновить работу' }).click();
        await held;
        await boardBox.click();
        await expect(boardBox).toBeChecked();
        releaseRead();
        await expect(boardBox).toBeEnabled();
        await expect(boardBox).toBeChecked();
        await page.locator(cardSelector + ' .kb-card-open').click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('textbox', { name: 'Название', exact: true }).fill('Новый заголовок ' + engine);
        const editorReads = reads;
        await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(cardSelector + ' strong')).toHaveText('Новый заголовок ' + engine);
        assert.equal(reads, editorReads, 'Use the committed task and board returned by the editor PATCH');
      }
      await page.getByRole('button', { name: 'Задачи', exact: true }).click();
      const listBox = page.getByRole('checkbox', { name: 'Выполнена: ' + other.title, exact: true });
      const listSelector = '.work-task-row input[aria-label="Выполнена: ' + other.title + '"]';
      for (let n = 0; n < samples; n++) {
        await expect(listBox).toBeEnabled();
        taskList.push(await observe(page, 'click', listSelector, 'gone', () => listBox.click()));
        await page.getByRole('button', { name: n % 2 ? 'Задачи' : 'Архив задач', exact: true }).click();
      }
      const openTask = () => page.getByRole('button', { name: 'Задача: ' + other.title, exact: true }).click();
      const dialog = page.getByRole('dialog');
      for (let n = 0; n < samples; n++) {
        await openTask();
        const action = dialog.getByRole('button', { name: n % 2 ? 'Вернуть в работу' : 'Выполнить', exact: true });
        editorOutcome.push(await observe(page, 'click', 'dialog.work-editor[open]', 'gone', () => action.click()));
        await expect(page.getByText('Сохраняем изменения задач…')).toHaveCount(0);
        await page.getByRole('button', { name: n % 2 ? 'Задачи' : 'Архив задач', exact: true }).click();
      }
      if (!baseline) {
        conflictPath = '/api/work/tasks/' + other.id;
        await openTask();
        const title = dialog.getByRole('textbox', { name: 'Название', exact: true });
        await title.fill('Введённые данные для повтора');
        await dialog.getByRole('button', { name: 'Выполнить', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(dialog.getByRole('alert')).toContainText('параллельно');
        await expect(title).toHaveValue('Введённые данные для повтора');
        await dialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(listBox).toBeVisible();
        await listBox.click(); await expect(listBox).toHaveCount(0);
        await expect(listBox).toBeEnabled();
        await expect(page.locator('.work-task-row').filter({ has: listBox }).getByRole('alert')).toContainText('параллельно');
        conflictPath = '';
        // Lose the HTTP acknowledgement after the server committed. Reconciliation
        // must move the row back to the archive without resending the mutation.
        await page.route('**/api/work/tasks/' + other.id, async route => {
          assert.ok((await route.fetch()).ok());
          await route.abort('failed');
        }, { times: 1 });
        await listBox.click();
        await expect(listBox).toHaveCount(0);
        await page.getByRole('button', { name: 'Архив задач', exact: true }).click();
        await expect(listBox).toBeChecked();
        await expect(listBox).toBeEnabled();
      }
      const timings = { completeFromBoard: summary(boardCheckbox), drag: summary(drag), completeFromList: summary(taskList), editorOutcome: summary(editorOutcome) };
      for (const timing of Object.values(timings)) assert.ok(baseline ? timing.median >= lagMs : timing.p95 < lagMs / 2, JSON.stringify(timing));
      assert.deepEqual(errors, []);
      report.browsers[engine] = { initialParallel, checkboxReads, timings };
      console.log(JSON.stringify({ engine, ...report.browsers[engine] }));
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify(report));
} finally {
  if (runtime) await runtime.server.close();
  await rm(temporary, { recursive: true, force: true });
}
