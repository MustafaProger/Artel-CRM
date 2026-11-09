import { chromium } from 'playwright-core';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { scope } from './balance.mjs';
import { readBalance } from './recover.mjs';
const statePath = '/state/worker/last-snapshot.json';
let previous;
try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* First collection. */ }
const at = new Date().toISOString();
const result = { version: 1, ...scope, createdAt: previous?.createdAt ?? at, lastAttemptAt: at, state: 'error' };
if (previous?.lastSuccessAt && previous?.balance) Object.assign(result, { lastSuccessAt: previous.lastSuccessAt, balance: previous.balance });
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15000 });
  const context = browser.contexts()[0];
  const balance = await readBalance(context);
  Object.assign(result, { state: 'connected', lastSuccessAt: new Date().toISOString(), balance });
  result.lastAttemptAt = result.lastSuccessAt;
} catch (e) {
  result.state = e?.message === 'auth' ? 'auth_required' : 'error';
  result.errorCode = ['auth', 'schema', 'scope'].includes(e?.message) ? e.message : 'unavailable';
} finally { if (browser) await browser.close(); }
await writeFile(statePath + '.tmp', JSON.stringify(result), { mode: 0o600 });
await rename(statePath + '.tmp', statePath);
process.stdout.write(JSON.stringify(result) + '\n');
