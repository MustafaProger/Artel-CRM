import { chromium, webkit, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../../', import.meta.url).pathname;
await mkdir(output + 'screenshots', { recursive: true });
const report = [];
for (const engine of ['chromium', 'webkit']) {
 const browser = await (engine === 'chromium' ? chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true }) : webkit.launch());
 try {
  for (const width of [375, 1440]) {
   const page = await browser.newPage({ viewport: { width, height: 1100 } });
   page.setDefaultTimeout(10000); const errors = []; page.on('pageerror', e => errors.push(e.message));
   await page.goto('http://127.0.0.1:5197/__preview');
   await page.getByRole('button', { name: 'Рейсы', exact: true }).click();
   const card = page.getByTestId('trip-card').filter({ hasText: '№52' });
   await expect(card).toHaveClass(/trip-has-error/);
   await expect(card.locator('h2')).toHaveCSS('background-color', 'rgb(255, 216, 212)');
   await expect(card).not.toHaveCSS('background-color', 'rgb(255, 241, 240)');
   await expect(card.locator('.trip-warning-icon')).toHaveCount(0);
   await expect(card.locator(':scope > .trip-workflow-alert')).toHaveCount(0);
   await expect(card.locator('.trip-edit-action .trip-issue-label')).toHaveText('Дополнить данные');
   await expect(page.getByTestId('trip-card').filter({ hasText: '№51' }).locator('.trip-warning-icon')).toHaveCount(0);
   await page.screenshot({ path: output + `screenshots/${engine}-${width}-cards.png`, fullPage: true });
   await card.getByRole('button', { name: 'Saby', exact: true }).click();
   await expect(card.locator('.workflow-steps .has-error')).toContainText('Отправка клиентам');
   await expect(card.locator('.workflow-step-error')).toContainText('Не заполнены сведения');
   await page.route('**/saby-workflow', async route => {
     const response = await route.fetch(); const body = await response.json();
     await route.fulfill({ json: { ...body, documentMode: 'nk_direct_etrn' } });
   });
   await card.getByRole('button', { name: 'Saby', exact: true }).click();
   await card.getByRole('button', { name: 'Saby', exact: true }).click();
   await expect(card.locator('.workflow-steps .has-error')).toContainText('Подпись перевозчика НК');
   await page.unroute('**/saby-workflow');
   await page.route('**/saby-workflow', async route => {
     const response = await route.fetch(); const body = await response.json();
     await route.fulfill({ json: { ...body, phase: 'completed', deliveries: [] } });
   });
   await card.getByRole('button', { name: 'Saby', exact: true }).click();
   await card.getByRole('button', { name: 'Saby', exact: true }).click();
   await expect(card).not.toHaveClass(/trip-has-error/);
   await expect(card.locator('.trip-issue-label')).toHaveCount(0);
   await expect(page.locator('body')).not.toContainText('Maximum update depth');
   if (errors.length) throw new Error(errors.join('\n'));
   const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
   if (overflow) throw new Error('Horizontal overflow at ' + width);
   report.push({ engine, width, passed: true }); await page.close();
  }
 } finally { await browser.close(); }
}
await writeFile(output + 'ui-report.json', JSON.stringify(report, null, 2)); console.log(report);
