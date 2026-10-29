import { chromium } from 'playwright-core';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fuelBalance, scope } from './balance.mjs';
const statePath = '/state/worker/last-snapshot.json';
let previous;
try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* First collection. */ }
const at = new Date().toISOString();
const result = { version: 1, ...scope, createdAt: previous?.createdAt ?? at, lastAttemptAt: at, state: 'error' };
if (previous?.lastSuccessAt && previous?.balance) Object.assign(result, { lastSuccessAt: previous.lastSuccessAt, balance: previous.balance });
let browser, page;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15000 });
  const context = browser.contexts()[0];
  page = context.pages().find(p => { try { return new URL(p.url()).hostname === 'business.taxi.yandex.ru'; } catch { return false; } });
  if (!page) throw Error('auth');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  // Observe the cabinet's own read request. No exported cookies, copied tokens or provider writes.
  const pending = page.waitForResponse(r => {
    const u = new URL(r.url());
    return u.origin === 'https://b2b-api-lk.go.yandex.ru' && u.pathname === '/corp-cabinet/3.0/contracts/list' && r.request().method() === 'GET';
  }, { timeout: 45000 });
  pending.catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  if (new URL(page.url()).hostname !== 'business.taxi.yandex.ru') throw Error('auth');
  const response = await pending;
  if ([401, 403].includes(response.status())) throw Error('auth');
  if (response.status() !== 200 || response.fromServiceWorker()) throw Error('provider');
  const company = await response.request().headerValue('x-yataxi-selected-corp-client-id');
  const data = await response.json();
  const balance = fuelBalance(data, company);
  Object.assign(result, { state: 'connected', lastSuccessAt: new Date().toISOString(), balance });
  result.lastAttemptAt = result.lastSuccessAt;
} catch (e) {
  const loginPage = page && /^https:\/\/passport\.yandex\./.test(page.url());
  result.state = e?.message === 'auth' || loginPage ? 'auth_required' : 'error';
  result.errorCode = ['auth', 'schema', 'scope'].includes(e?.message) ? e.message : 'unavailable';
} finally { if (browser) await browser.close(); }
await writeFile(statePath + '.tmp', JSON.stringify(result), { mode: 0o600 });
await rename(statePath + '.tmp', statePath);
process.stdout.write(JSON.stringify(result) + '\n');
