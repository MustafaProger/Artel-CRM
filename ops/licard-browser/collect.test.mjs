import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseRubles } from './collect.mjs';

test('balance precision for both Licard formats', () => {
  for (const [text, expected] of [
    ['227,106.1 ₽', 22710610], ['259 674,99 ₽', 25967499],
    ['-1 255,62 ₽', -125562], ['0 ₽', 0], ['1,23,4 ₽', null],
  ]) assert.equal(parseRubles(text), expected);
});

test('browser login asks for a code and resumes contract balance after confirmation', { timeout: 35_000 }, async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const browser = await chromium.launch({ args: ['--remote-debugging-port=' + port] });
  const worker = (action, fields) => new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, [fileURLToPath(new URL('./collect.mjs', import.meta.url)), ...action ? [action] : []], {
      env: { ...process.env, ARTEL_LICARD_CDP_URL: 'http://127.0.0.1:' + port },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    processHandle.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    processHandle.on('error', reject);
    processHandle.on('exit', status => {
      if (status) reject(new Error('Worker exited with ' + status));
      else resolve(JSON.parse(output));
    });
    processHandle.stdin.end(fields ? JSON.stringify(fields) : '');
  });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://lk.licard.com') return route.abort();
      const auth = `<main>
        <input type=text><input type=password><button>Войти</button>
        </main><script>
        document.querySelector('button').onclick = () => {
          if (document.querySelector('input[type=text]').value !== 'fixture@example.org' ||
              document.querySelector('input[type=password]').value !== 'test-password') return;
          document.querySelector('main').innerHTML = '<h1>Подтверждение входа</h1><input placeholder="Код подтверждения"><button disabled>Войти</button>';
          document.querySelector('input').oninput = () => { document.querySelector('button').disabled = false; };
          document.querySelector('button').onclick = () => {
            if (document.querySelector('input').value === '001234') location.assign('/');
          };
        };
        </script>`;
      const dashboard = '<p>RU260007461</p><section><div><h5>Баланс</h5></div><p>227,106.1 ₽</p><button>Пополнить баланс</button><p>Последний платеж 200,000 ₽</p></section>';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.pathname === '/auth' ? auth : dashboard });
    });
    const page = await context.newPage();
    await page.goto('https://lk.licard.com/auth');
    assert.deepEqual(await worker(), { state: 'auth_required' });
    assert.deepEqual(await worker('login', { login: 'fixture@example.org', password: 'test-password' }), { state: 'code_required' });
    assert.deepEqual(await worker('code', { code: '001234' }), { state: 'connected' });
    assert.deepEqual(await worker(), { state: 'connected', amountMinor: 22710610 });
  } finally {
    await browser.close();
  }
});
