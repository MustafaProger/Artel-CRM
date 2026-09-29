// Optional private HTML/PDF rendering after replay_saby_etrn.py. No CRM server.
import { chromium } from '@playwright/test';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --output PRIVATE_DIRECTORY');
const output = await realpath(process.argv[index + 1]);
const inside = (parent, child) => { const path = relative(parent, child); return !path.startsWith('..') && !isAbsolute(path); };
if (inside(root, output)) throw new Error('Private output must be outside the checkout');
process.umask(0o077);
const browser = await chromium.launch({ headless: true, executablePath: process.env.ETRN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const checks = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:' && inside(output, fileURLToPath(url))) return route.continue();
    errors.push('Unexpected request blocked');
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('Browser page error'));
  for (const name of ['test-document', 'comparison']) {
    const input = resolve(output, `${name}.html`);
    if ((await lstat(input)).isSymbolicLink()) throw new Error('Symlink input refused');
    await page.goto(pathToFileURL(input).href);
    await page.locator('h1').waitFor();
    if (await page.locator('table').count() === 0) throw new Error('Missing document tables');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) throw new Error('Horizontal overflow');
      const screenshot = resolve(output, `${name}-${width}.png`);
      if (await lstat(screenshot).then(s => s.isSymbolicLink()).catch(() => false)) throw new Error('Symlink output refused');
      await page.screenshot({ path: screenshot, fullPage: false });
      await chmod(screenshot, 0o600);
      checks.push(`${name}: viewport ${width}: no horizontal overflow`);
    }
    if (name === 'test-document') {
      const pdf = resolve(output, 'test-document.pdf');
      if (await lstat(pdf).then(s => s.isSymbolicLink()).catch(() => false)) throw new Error('Symlink output refused');
      await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true,
        displayHeaderFooter: true, headerTemplate: '<span></span>',
        footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#63717b">АРТЭЛЬ · ЛОКАЛЬНЫЙ ТЕСТ · БЕЗ ПОДПИСИ &nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
      await chmod(pdf, 0o600);
      checks.push('First-title PDF rendered from generated XML preview');
    }
  }
  if (errors.length) throw new Error('Browser errors or external requests');
  const sha = async name => createHash('sha256').update(await readFile(resolve(output, name))).digest('hex');
  const report = { offline: true, workingStoreAccessed: false, externalRequests: 0, checks, errors,
    generatedXmlSha256: await sha('generated-title-1.xml'), previewHtmlSha256: await sha('test-document.html'),
    pdfSha256: await sha('test-document.pdf') };
  await writeFile(resolve(output, 'browser-checks.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ browserChecks: checks.length, errors: errors.length, externalRequests: 0 }));
} finally {
  await browser.close();
}
