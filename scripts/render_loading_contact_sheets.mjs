// Contact sheets are browser layouts embedding unaltered original screenshots.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const output = resolve(process.argv[2] || '../reaudit-20261105/after-evidence');
const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'));
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const browser = await chromium.launch();
try {
  for (const item of report.cases.filter(c => c.engine === 'chromium' && c.mode === 'cold')) {
    const filename = `contact-${item.route}-${item.width}`, html = `<!doctype html><html lang="ru"><meta charset="utf-8"><style>*{box-sizing:border-box}body{background:#f2f4f2;color:#1a2921;margin:24px;font:16px system-ui}h1{font-size:25px;margin:0 0 6px}p{margin:0 0 18px;color:#526158}.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}figure{margin:0;min-width:0;background:#fff;border:1px solid #d6dfd7;border-radius:9px;padding:8px}figcaption{min-height:62px;font-size:14px;font-weight:600;line-height:1.5}span{display:block;color:#526158;font-size:12px;font-weight:400}img{display:block;width:100%;height:auto}</style><h1>${esc(item.title)} · ${item.width} px · Chromium</h1><p>Холодное открытие после исправления. Оригинальные снимки браузера, четыре контролируемых этапа.</p><div class="strip">${item.screenshots.map((shot,i) => `<figure><figcaption>${i+1}. ${(i === 0 ? 'Начало загрузки' : i === 3 ? 'Содержимое' : shot.skeletons?.length ? 'Данные загружаются' : shot.statuses?.length ? 'Раздел загружается' : 'Содержимое получено')}<span>${Math.round(shot.timeBefore)}–${Math.round(shot.timeAfter)} мс · DOM ${shot.frameBefore}–${shot.frameAfter}</span></figcaption><img src="${item.name}/${shot.file}"></figure>`).join('')}</div></html>`;
    const path = resolve(output, filename + '.html'); await writeFile(path, html); const page = await browser.newPage({ viewport: { width: item.width === 375 ? 1660 : 1920, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path).href); await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode()))); const bounds = await page.locator('body').boundingBox(); await page.setViewportSize({ width: item.width === 375 ? 1660 : 1920, height: Math.ceil(bounds.y + bounds.height + 24) }); await page.screenshot({ path: resolve(output, filename + '.png'), fullPage: true }); await page.close(); console.log(filename);
  }
} finally { await browser.close(); }
