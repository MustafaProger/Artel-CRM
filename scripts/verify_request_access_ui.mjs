// Browser verification and optional preview with synthetic data, loopback only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { decode } from 'jpeg-js';
import { integrationRuntime } from '../tests/helpers/trip-saby-integration.ts';
import { authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

function twoPageAvatarPdf() {
  const red = '1 0 0 rg 0 0 100 100 re f', blue = '0 0 1 rg 0 0 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    `<< /Length ${red.length} >>\nstream\n${red}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R >>',
    `<< /Length ${blue.length} >>\nstream\n${blue}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, '0') + ' 00000 n \n';
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'ascii');
}

const root = resolve(import.meta.dirname, '..');
const preview = process.argv.includes('--preview');
const fixture = await integrationRuntime();
let server, browser;
try {
  await fixture.store.mutate(fixture.source, data => {
    data.directories.managers.push(...['nur', 'colleague'].map(id => ({ id, name: id === 'nur' ? 'Нуры (демо)' : 'Коллега (демо)' })));
    const card = (id, name, roles) => ({ id, name, roles, managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
    data.companies.push(card('dual', 'ТАТНЕФТЕХИМ (демо)', ['customer', 'supplier']), card('other', 'Вторая точка (демо)', ['customer']));
    data.directories.customerManagers = [{ companyId: 'dual', managerId: 'nur' }, { companyId: 'other', managerId: 'colleague' }];
    data.directories.addresses.push(
      { id: 'dual-site', companyId: 'dual', kind: 'delivery', name: 'Первая площадка', address: 'Москва, тестовая площадка 1', latitude: '55.7', longitude: '37.6' },
      { id: 'other-site', companyId: 'other', kind: 'delivery', name: 'Вторая площадка', address: 'Москва, тестовая площадка 2', latitude: '55.8', longitude: '37.7' },
    );
    return { changed: true, result: null };
  });
  const runtime = await startTripsQaServer({ root, snapshotDirectory: fixture.snapshotDirectory, operationsDirectory: resolve(fixture.directory, 'store'), port: preview ? 5182 : 0 });
  const { base } = runtime;
  server = runtime.server;
  const password = preview ? 'DemoLocal-2026' : randomUUID();
  const api = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const ok = async (...args) => {
    const result = await api(...args);
    assert.ok(result.status < 300, `${args[1] ?? 'GET'} ${args[0]}: ${JSON.stringify(result.data)}`);
    return result;
  };
  const director = await ok('/api/auth/setup', 'POST', { name: 'Айдар (демо)', login: 'demo.director', password });
  const employee = async (login, managerId, name) => {
    await ok('/api/auth/users', 'POST', { name, login, password, role: 'manager', managerId, sections: ['overview', 'work', 'trips', 'directories', 'invoices'] }, director.cookie);
    return ok('/api/auth/login', 'POST', { login, password });
  };
  const nur = await employee('demo.nur', 'nur', 'Нуры (демо)');
  const colleague = await employee('demo.colleague', 'colleague', 'Коллега (демо)');
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' }).format();
  const request = async (companyId, addressId, quantityLitres, cookie) => (await ok('/api/trip-requests', 'POST', {
    companyId, addressId, quantityLitres, executionDate: day, idempotencyKey: randomUUID(),
  }, cookie)).data.request;
  const first = await request('dual', 'dual-site', '3000', nur.cookie);
  const second = await request('other', 'other-site', '2000', director.cookie);
  await request('dual', 'dual-site', '1234', nur.cookie);
  await request('other', 'other-site', '9876', director.cookie);
  const { data: { trip } } = await ok('/api/shipment-trips', 'POST', {
    idempotencyKey: randomUUID(),
    fields: {
      trip_flow_version: 'driver-v1', loading_at: `${day}T09:00`, organization_id: 'artel',
      supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product',
      purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle',
      additional_costs: '0', intermediate_stops_in_order: 'true',
    },
    customers: [first, second].map((source, index) => ({
      sourceRequestId: source.id, sourceRequestVersion: source.version,
      fields: {
        manager_id: index ? 'colleague' : 'nur', payment_form_id: 'payment', transport_amount: '0',
        sale_price_per_litre: '81.27',
        ...(index ? {} : { intermediate_stops_after: JSON.stringify([{ id: 'rest', name: 'Промежуточная точка (демо)', address: 'Тестовая остановка' }]) }),
      },
    })),
  }, director.cookie);
  const { data: access } = await ok('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' }, director.cookie);
  const driver = await ok('/api/auth/login', 'POST', { login: access.access.login, password: access.temporaryPassword });
  const driverPath = `/api/driver/trips/${trip.id}`;
  const versions = Object.fromEntries(trip.customers.map(row => [row.id, row.version]));
  const { data: arrived } = await ok(`${driverPath}/arrive`, 'POST', { versions }, driver.cookie);
  const { data: departed } = await ok(`${driverPath}/depart`, 'POST', {
    versions: arrived.trip.versions, masses: trip.customers.map(row => ({ deliveryId: row.id, netTonnes: '1' })),
  }, driver.cookie);
  const { data: delivered } = await ok(`${driverPath}/deliver`, 'POST', {
    versions: departed.trip.versions, executionVersion: 0, deliveryId: trip.customers[0].id,
  }, driver.cookie);
  const firstAt = delivered.trip.execution.deliveries[trip.customers[0].id].at;
  if (preview) {
    const { data: { entry: demoTask } } = await ok('/api/work/tasks', 'POST', {
      title: 'Сверить время доставки', dueDate: day, assigneeIds: [nur.data.user.id], requestId: randomUUID(),
    }, director.cookie);
    await ok(`/api/work/tasks/${demoTask.id}`, 'PATCH', {
      version: demoTask.version, comment: 'Первую точку подтвердили.',
    }, nur.cookie);
    console.log(`Стенд: ${base}/#trips · demo.nur / demo.director / demo.colleague · пароль: ${password}`);
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  } else {
    const output = resolve(root, 'qa/request-access'); await mkdir(output, { recursive: true });
    const errors = [];
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
      browser = await launcher.launch();
      const contextFor = async (account, width) => {
        const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
        await authenticateContext(context, base, account.cookie);
        await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        return page;
      };
      const nurPage = await contextFor(nur, 390);
      await nurPage.goto(base + '/#trips');
      await expect(nurPage.getByRole('region', { name: 'Заявки на доставку' })).toContainText('ТАТНЕФТЕХИМ (демо)');
      await expect(nurPage.getByRole('region', { name: 'Заявки на доставку' })).not.toContainText('Вторая точка (демо)');
      await nurPage.getByRole('button', { name: 'Карта', exact: true }).click();
      const map = nurPage.getByRole('region', { name: 'Карта заявок' });
      await expect(map.getByRole('list', { name: 'Площадки заявок' })).toContainText('ТАТНЕФТЕХИМ (демо)');
      await expect(map.getByRole('list', { name: 'Площадки заявок' })).not.toContainText('Вторая точка (демо)');
      await nurPage.getByRole('button', { name: 'В процессе', exact: true }).click();
      await nurPage.getByTestId('execution-trip').filter({ hasText: 'Общий рейс · Только просмотр' }).locator('summary').click();
      const route = nurPage.getByRole('list', { name: 'Порядок точек рейса' });
      await expect(route.getByRole('listitem')).toHaveCount(3);
      await expect(route.getByRole('listitem').nth(0)).toContainText('ТАТНЕФТЕХИМ (демо)');
      await expect(route.getByRole('listitem').nth(1)).toContainText('Промежуточная точка (демо)');
      await expect(route.getByRole('listitem').nth(2)).toContainText('Вторая точка (демо)');
      await expect(route.getByRole('listitem').nth(0)).toContainText('Ваша заявка');
      await expect(route.getByRole('listitem').nth(2)).toContainText('Ожидает отметки');
      await expect(route.getByRole('listitem').nth(0).locator('time').first()).toHaveAttribute('datetime', firstAt);
      await expect(route).not.toContainText(/81[,.]27/);
      await expect(route.getByRole('button')).toHaveCount(0);
      await expect(nurPage.getByText('Общий рейс · Только просмотр')).toBeVisible();
      await nurPage.screenshot({ path: resolve(output, `${engine}-shared-route-mobile.png`), fullPage: true });
      const denied = await api(`/api/shipment-trips/${trip.id}`, 'GET', undefined, nur.cookie);
      assert.equal(denied.status, 403);
      const colleaguePage = await contextFor(colleague, 1440);
      await colleaguePage.goto(base + '/#trips');
      await colleaguePage.getByRole('button', { name: 'В процессе', exact: true }).click();
      await expect(colleaguePage.getByRole('heading', { name: 'Рейсы не найдены' })).toBeVisible();

      await nurPage.goto(base + '/#directories');
      await nurPage.getByRole('button', { name: 'Редактировать: ТАТНЕФТЕХИМ (демо)', exact: true }).click();
      const name = nurPage.getByLabel('Наименование', { exact: true });
      const previous = await name.inputValue();
      await name.fill(`${previous} · QA`);
      await nurPage.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(nurPage.getByText('Изменения сохранены', { exact: true })).toBeVisible();
      const { companies } = (await ok('/api/directories', 'GET', undefined, director.cookie)).data;
      assert.deepEqual(companies.find(row => row.id === 'dual').roles.toSorted(), ['customer', 'supplier']);
      await nurPage.getByRole('button', { name: 'Поставщики', exact: true }).click();
      await expect(nurPage.getByRole('button', { name: 'Редактировать: Синтетический поставщик', exact: true })).toHaveCount(0);
      await nurPage.getByRole('button', { name: `Редактировать: ${previous} · QA`, exact: true }).click();
      await nurPage.getByLabel('Наименование', { exact: true }).fill(previous);
      await nurPage.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(nurPage.getByRole('button', { name: `Редактировать: ${previous}`, exact: true })).toBeVisible();

      const directorPage = await contextFor(director, 1440);
      await directorPage.goto(base + '/#work');
      await directorPage.locator('.sidebar-settings-link').click();
      await expect(directorPage).toHaveURL(/#settings$/);
      await expect(directorPage.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
      const directorSettings = directorPage.getByRole('region', { name: 'Уведомления', exact: true });
      const tasks = directorSettings.getByRole('switch', { name: 'Задачи', exact: true });
      await expect(tasks).toBeChecked();
      await tasks.click();
      await expect(tasks).not.toBeChecked();
      await expect(directorSettings.getByRole('switch', { name: 'Заявки на рейс' })).toBeChecked();
      await directorPage.screenshot({ path: resolve(output, `${engine}-personal-notifications.png`) });

      await nurPage.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      await nurPage.locator('.sidebar-settings-link').click();
      await expect(nurPage).toHaveURL(/#settings$/);
      const personal = nurPage.locator('.personal-settings-page');
      const personalNotifications = personal.getByRole('region', { name: 'Уведомления', exact: true });
      await expect(personalNotifications.getByRole('switch', { name: 'Задачи', exact: true })).toBeChecked();
      await expect(personalNotifications.getByRole('switch', { name: 'Заявки на рейс' })).toHaveCount(0);
      await tasks.click();
      await expect(tasks).toBeChecked();
      const profile = personal.getByRole('region', { name: 'Профиль', exact: true });
      const originalName = nur.data.user.name, originalLogin = nur.data.user.login;
      const editedName = 'Нуры (профиль QA)', editedLogin = 'demo.nur.qa';
      const editProfile = profile.getByRole('button', { name: 'Изменить имя и логин', exact: true });
      const display = profile.getByRole('textbox', { name: 'Имя в CRM', exact: true });
      const loginField = profile.getByRole('textbox', { name: 'Логин', exact: true });
      const saveProfile = profile.getByRole('button', { name: 'Сохранить', exact: true });
      await expect(display).toHaveValue(originalName);
      await expect(loginField).toHaveValue(originalLogin);
      await expect(display).not.toBeEditable();
      await expect(loginField).not.toBeEditable();
      await expect(saveProfile).toHaveCount(0);
      const loginFirst = await loginField.evaluate(input => {
        const name = input.parentElement.querySelector('input[name="name"]');
        return input.getBoundingClientRect().top < name.getBoundingClientRect().top;
      });
      assert.equal(loginFirst, true, 'The login is displayed above the name');
      await editProfile.click();
      await display.fill('Несохранённое имя');
      await display.press('Escape');
      await expect(display).toHaveValue(originalName);
      await expect(display).not.toBeEditable();
      await editProfile.click();
      await expect(display).toHaveValue(originalName);
      await expect(loginField).toHaveValue(originalLogin);
      const rightAligned = async button => {
        const offset = await button.evaluate(element =>
          element.closest('form').getBoundingClientRect().right - element.getBoundingClientRect().right);
        assert.ok(Math.abs(offset) <= 1, 'The save button aligns to the right of its form');
      };
      await rightAligned(saveProfile);
      for (const settings of [personal, directorPage.locator('.personal-settings-page')]) {
        await rightAligned(settings.getByRole('button', { name: 'Сохранить пароль', exact: true }));
      }
      await display.fill(editedName);
      await loginField.fill(editedLogin);
      await saveProfile.click();
      await expect(nurPage.locator('.sidebar-profile > span')).toHaveText(editedName);
      await expect(loginField).toHaveValue(editedLogin);
      await expect(loginField).not.toBeEditable();
      assert.equal((await api('/api/auth/login', 'POST', { login: originalLogin, password })).status, 401);
      const renamed = await ok('/api/auth/login', 'POST', { login: editedLogin, password });
      assert.equal(renamed.data.user.id, nur.data.user.id);
      await nurPage.reload();
      await expect(loginField).toHaveValue(editedLogin);
      await expect(display).toHaveValue(editedName);
      await editProfile.click();
      await display.fill(originalName);
      await loginField.fill(originalLogin);
      await saveProfile.click();
      await expect(nurPage.locator('.sidebar-profile > span')).toHaveText(originalName);
      await expect(loginField).toHaveValue(originalLogin);
      await ok('/api/auth/login', 'POST', { login: originalLogin, password });

      const photo = profile.getByRole('group', { name: 'Аватар профиля', exact: true });
      const gallery = photo.getByRole('group', { name: 'Выбор аватара', exact: true });
      const galleryToggle = photo.getByRole('button', { name: 'Изменить аватар', exact: true });
      const openGallery = async () => {
        if (await galleryToggle.getAttribute('aria-expanded') !== 'true') await galleryToggle.click();
        await expect(galleryToggle).toHaveAttribute('aria-expanded', 'true');
      };
      const uploadAvatar = async file => {
        await openGallery();
        const [chooser] = await Promise.all([
          nurPage.waitForEvent('filechooser'),
          gallery.getByRole('button', { name: 'Загрузить аватар', exact: true }).click(),
        ]);
        await chooser.setFiles(file);
      };
      const photoPreview = photo.locator('.user-avatar img');
      await uploadAvatar({ name: 'avatar.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
      await expect(profile.getByRole('alert')).toHaveText('Выберите файл JPG, PNG, WebP или PDF.');
      let previousUrl = '';
      for (const [type, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
        const buffer = type === 'webp' ? await readFile(resolve(root, 'web/public/avatars/preset-01.webp'))
          : Buffer.from(await nurPage.evaluate(mimeType => {
            const canvas = document.createElement('canvas');
            canvas.width = 480;
            canvas.height = 320;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = mimeType === 'image/png' ? '#185c4a' : '#435792';
            ctx.fillRect(0, 0, 480, 320);
            ctx.fillStyle = '#efab7b';
            ctx.fillRect(140, 35, 200, 250);
            return canvas.toDataURL(mimeType).split(',')[1];
          }, mime), 'base64');
        await uploadAvatar({ name: `avatar.${type}`, mimeType: mime, buffer });
        await expect(profile.getByText('Фото профиля сохранено.', { exact: true })).toBeVisible();
        await expect(photoPreview).toHaveAttribute('src', /^\/api\/auth\/avatars\//);
        await expect(photoPreview).not.toHaveAttribute('src', previousUrl);
        await expect.poll(() => photoPreview.evaluate(img => img.complete && img.naturalWidth === img.naturalHeight && img.naturalWidth > 0 && img.naturalWidth <= 256)).toBe(true);
        previousUrl = await photoPreview.getAttribute('src');
      }
      await uploadAvatar({ name: 'two-page-avatar.pdf', mimeType: 'application/pdf', buffer: twoPageAvatarPdf() });
      await expect(profile.getByText('Фото профиля сохранено.', { exact: true })).toBeVisible();
      await expect(photoPreview).not.toHaveAttribute('src', previousUrl);
      const pdfAvatar = await photoPreview.getAttribute('src');
      assert.match(pdfAvatar, /^\/api\/auth\/avatars\//);
      const storedPdfAvatar = await fetch(base + pdfAvatar, { headers: { cookie: nur.cookie } });
      assert.equal(storedPdfAvatar.status, 200);
      const image = decode(Buffer.from(await storedPdfAvatar.arrayBuffer()));
      const center = 4 * (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2));
      const [red, green, blue] = image.data.subarray(center, center + 3);
      assert.ok(red > 200 && green < 60 && blue < 60, 'The profile image comes from the first (red) page of the PDF');
      await nurPage.reload();
      await expect(photoPreview).toHaveAttribute('src', pdfAvatar);
      await openGallery();
      await gallery.getByRole('button', { name: 'Удалить аватар', exact: true }).click();
      await expect(profile.getByText('Фото профиля удалено.', { exact: true })).toBeVisible();
      await expect(photoPreview).toHaveCount(0);
      await nurPage.screenshot({ path: resolve(output, `${engine}-personal-profile-mobile.png`), fullPage: true });

      const newPassword = randomUUID();
      const current = personal.getByLabel('Текущий пароль', { exact: true });
      const next = personal.getByLabel('Новый пароль', { exact: true });
      const repeat = personal.getByLabel('Повторите новый пароль', { exact: true });
      await current.fill(password);
      await next.fill(newPassword);
      await repeat.fill('Не совпадающий пароль');
      await personal.getByRole('button', { name: 'Сохранить пароль', exact: true }).click();
      await expect(repeat).toBeFocused();
      await expect(personal.getByText('Пароли не совпадают.', { exact: true })).toBeVisible();
      await repeat.fill(newPassword);
      await personal.getByRole('button', { name: 'Сохранить пароль', exact: true }).click();
      await expect(personal.getByText('Пароль изменён', { exact: false })).toBeVisible();
      assert.equal((await api('/api/auth/login', 'POST', { login: 'demo.nur', password })).status, 401);
      const signedWithNewPassword = await ok('/api/auth/login', 'POST', { login: originalLogin, password: newPassword });
      assert.equal(signedWithNewPassword.data.user.id, nur.data.user.id);
      const { data: { user } } = await ok('/api/auth/session', 'GET', undefined, nur.cookie);
      assert.equal(user.name, originalName, 'The current session survives password change');
      await ok('/api/auth/profile', 'PATCH', { version: user.version, currentPassword: newPassword, newPassword: password }, nur.cookie);

      console.log(`PASS ${engine}: карта, общий рейс, права справочника, личные настройки, имя и логин, фото профиля из изображения и PDF, смена пароля`);
      await browser.close(); browser = null;
    }
    assert.deepEqual(errors, []);
  }
} finally {
  await browser?.close();
  await server?.close();
  await fixture.close();
}
