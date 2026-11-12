// Real Work and profile endpoints backed by an isolated synthetic store.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { encode } from 'jpeg-js';
import { integrationRuntime } from '../tests/helpers/trip-saby-integration.ts';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const fixture = await integrationRuntime();
let runtime, browser;
try {
  runtime = await startTripsQaServer({
    root, snapshotDirectory: fixture.snapshotDirectory,
    operationsDirectory: resolve(fixture.directory, 'store'),
  });
  const { base } = runtime;
  const director = await bootstrapQaAuth(base);
  const api = async (path, method, body, cookie) => {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error ?? ''}`);
    return { data: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const jpeg = encode({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 4, 180) }, 80).data;
  const { data: { user: author } } = await api('/api/auth/profile', 'PATCH', {
    version: director.user.version, avatar: 'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64'),
  }, director.cookie);
  const login = 'work-comment-author', password = randomUUID(), name = '🌿 Нуры (демо)';
  await api('/api/auth/users', 'POST', {
    login, password, name, managerId: 'manager', role: 'employee', sections: ['work'],
  }, director.cookie);
  const employee = await api('/api/auth/login', 'POST', { login, password });
  const { user: commenter } = employee.data;
  assert.ok(author.avatarUrl);

  const createTask = async (title, assigneeIds) => (await api('/api/work/tasks', 'POST', {
    title, assigneeIds, status: 'todo', requestId: randomUUID(),
  }, director.cookie)).data.entry;
  const task = await createTask('Проверка автора и исполнителя', [commenter.id]);
  await createTask('Задача на себя', [author.id]);
  await api(`/api/work/tasks/${task.id}`, 'PATCH', {
    version: task.version, comment: 'Комментарий исполнителя',
  }, employee.cookie);
  const { data: { entry: company } } = await api('/api/work/companies', 'POST', {
    companyId: 'customer', assigneeId: commenter.id, question: 'Вопрос по компании',
    comment: 'Комментарий директора', requestId: randomUUID(),
  }, director.cookie);
  await api(`/api/work/companies/${company.id}`, 'PATCH', {
    version: company.version, comment: 'Ответ сотрудника',
  }, employee.cookie);

  const output = resolve(root, 'qa/work-avatars');
  await mkdir(output, { recursive: true });
  for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['webkit', webkit, 390]]) {
    browser = await launcher.launch();
    const errors = [];
    const pageFor = async cookie => {
      const context = await browser.newContext({ viewport: { width, height: 920 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await authenticateContext(context, base, cookie);
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      return page;
    };
    const page = await pageFor(director.cookie);
    const profile = await pageFor(employee.cookie);
    await profile.goto(base + '/#settings');
    const photo = profile.getByRole('group', { name: 'Аватар профиля', exact: true });
    await expect(photo.locator('.user-avatar')).toHaveCSS('background-color', 'rgb(219, 230, 224)');
    await expect(photo.locator('.user-avatar')).toHaveCSS('color', 'rgb(24, 102, 71)');
    const gallery = photo.getByRole('group', { name: 'Выбор аватара', exact: true });
    const galleryToggle = photo.getByRole('button', { name: 'Изменить аватар', exact: true });
    const openGallery = async () => {
      if (await galleryToggle.getAttribute('aria-expanded') !== 'true') await galleryToggle.click();
      await expect(galleryToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(gallery).toBeVisible();
    };
    await openGallery();
    const presetTiles = gallery.getByRole('button').filter({ has: profile.locator('img') });
    await expect(presetTiles).toHaveCount(30);
    await expect(gallery.getByRole('button').first()).toHaveAccessibleName('Загрузить аватар');
    await gallery.getByRole('button', { name: 'Горы', exact: true }).click();
    await expect(profile.getByText('Фото профиля сохранено.', { exact: true })).toBeVisible();
    await expect(photo.locator('.user-avatar img')).toBeVisible();
    const presetUrl = await photo.locator('.user-avatar img').getAttribute('src');
    assert.match(presetUrl, /preset-01/);
    const expectPhoto = async (wrapper, url) => {
      const image = wrapper.locator('.user-avatar img');
      await expect(image).toHaveAttribute('src', url);
      await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
      await expect(image).toHaveCSS('width', '18px');
    };

    await page.goto(base + '/#work');
    const row = page.getByRole('button', { name: 'Задача: Проверка автора и исполнителя', exact: true });
    const creator = row.locator('[title="Автор задачи"]');
    await expect(creator).toContainText(author.name);
    await expectPhoto(creator, author.avatarUrl);
    await expect(row.locator('.work-task-assignees')).toHaveText(`Исполнитель: ${name}`);
    const self = page.getByRole('button', { name: 'Задача: Задача на себя', exact: true });
    await expect(self.locator('.work-person-name')).toHaveCount(1);
    await expect(self.locator('.work-task-assignees')).toHaveCount(0);
    await page.screenshot({ path: resolve(output, `${engine}-task-list.png`) });

    await row.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Комментарии (1)', exact: true }).click();
    const comment = dialog.getByRole('region', { name: 'История комментариев' }).getByRole('listitem');
    await expect(comment).toContainText('Комментарий исполнителя');
    await expect(comment.locator('.work-person-name')).toContainText(name);
    await expectPhoto(comment.locator('.work-person-name'), presetUrl);
    await expect(comment.locator('.work-activity-icon svg')).toHaveCount(1);
    await page.screenshot({ path: resolve(output, `${engine}-task-comment.png`) });

    await dialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
    await page.getByRole('button', { name: 'Работа с компанией: ИП ПолучательТестовый Тест', exact: true }).click();
    const companyComments = dialog.locator('.work-comments article');
    await expect(companyComments).toHaveCount(2);
    await expectPhoto(companyComments.filter({ hasText: 'Ответ сотрудника' }), presetUrl);
    await expectPhoto(companyComments.filter({ hasText: 'Комментарий директора' }), author.avatarUrl);
    await openGallery();
    await gallery.getByRole('button', { name: 'Удалить аватар', exact: true }).click();
    await expect(profile.getByText('Фото профиля удалено.', { exact: true })).toBeVisible();
    await expect(photo.locator('.user-avatar img')).toHaveCount(0);
    await page.reload();
    await row.click();
    await dialog.getByRole('button', { name: 'Комментарии (1)', exact: true }).click();
    await expect(comment.locator('.user-avatar')).toHaveText('Н');
    await expect(comment.locator('.user-avatar img')).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine}: creator photo, separate assignee, task and company comment photos, preset removal and initials`);
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  await runtime?.server.close();
  await fixture.close();
}
