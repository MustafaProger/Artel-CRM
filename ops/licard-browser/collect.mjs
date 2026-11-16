const origin = 'https://lk.licard.com';
const contract = 'RU260007461';

export function parseRubles(text) {
  const value = text.trim().replace(/\s*₽$/, '').trim();
  if (!text.trim().endsWith('₽')) return null;
  const russian = /^-?(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:,\d{1,2})?$/;
  const english = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
  const normalized = russian.test(value) ? value.replace(/\s/g, '').replace(',', '.')
    : english.test(value) ? value.replace(/,/g, '') : null;
  if (normalized === null) return null;
  const [integer, fraction = ''] = normalized.replace(/^-/, '').split('.');
  const minor = Number(integer + fraction.padEnd(2, '0')) * (normalized.startsWith('-') ? -1 : 1);
  return Number.isSafeInteger(minor) ? minor : null;
}

async function withLicardTab(inTab) {
  const response = await fetch((process.env.ARTEL_LICARD_CDP_URL || 'http://127.0.0.1:9222') + '/json/list', { signal: AbortSignal.timeout(5000) });
  const tabs = (await response.json()).filter(tab => tab.type === 'page' && new URL(tab.url).origin === origin);
  if (tabs.length !== 1) return { state: 'error' };
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  try {
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      const { id, result, error } = JSON.parse(data);
      const callbacks = pending.get(id);
      if (!callbacks) return;
      pending.delete(id);
      if (error) callbacks.reject(new Error('Browser command failed'));
      else callbacks.resolve(result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (fn, argument) => {
      const { result, exceptionDetails } = await call('Runtime.evaluate', {
        expression: '(' + fn.toString() + ')(' + JSON.stringify(argument) + ')',
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error('Browser page evaluation failed');
      return result?.value;
    };
    return await inTab({ call, evaluate, url: tabs[0].url });
  } finally {
    ws.close();
  }
}

async function readDashboard() {
  return withLicardTab(async ({ call, evaluate, url }) => {
    const read = () => evaluate(inspectDashboard, contract);
    const initial = await read();
    if (initial?.auth) return { state: 'auth_required' };
    await call('Page.enable');
    if (url === origin + '/') await call('Page.reload', { ignoreCache: true });
    else await call('Page.navigate', { url: origin + '/' });
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const view = await read().catch(() => null);
      if (view?.auth) return { state: 'auth_required' };
      const amountMinor = view?.loadedAt !== initial?.loadedAt && view?.amount ? parseRubles(view.amount) : null;
      if (amountMinor !== null) return { state: 'connected', amountMinor };
    }
    return { state: 'error' };
  });
}

function inspectDashboard(expectedContract) {
  if (location.origin !== 'https://lk.licard.com') return {};
  if (location.pathname === '/auth') return { auth: true };
  if (location.pathname !== '/' || document.readyState !== 'complete') return {};
  const text = (document.body?.innerText ?? '').split('\n').map(line => line.trim());
  const contracts = new Set(text.filter(line => /^RU\d+$/.test(line)));
  if (contracts.size !== 1 || !contracts.has(expectedContract)) return {};
  const titles = [...document.querySelectorAll('h5')].filter(heading => heading.innerText.trim() === 'Баланс');
  if (titles.length !== 1) return {};
  const lines = titles[0].parentElement.parentElement.innerText.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] === 'Баланс' && lines[2] === 'Пополнить баланс') return { amount: lines[1], loadedAt: performance.timeOrigin };
  return {};
}

function authPage() {
  if (location.origin !== 'https://lk.licard.com' || location.pathname !== '/auth') return {};
  const text = document.body?.innerText ?? '';
  const password = document.querySelector('input[type=password]');
  const inputs = [...document.querySelectorAll('input:not([type=hidden])')].filter(input => input.getClientRects().length);
  const code = text.includes('Подтверждение входа') && !password && inputs.length === 1;
  return { password: !!password, code, expired: /срок действия кода ист[её]к/i.test(text) };
}

function fillAuthPage({ login, password, code }) {
  if (location.origin !== 'https://lk.licard.com' || location.pathname !== '/auth') return false;
  const visible = element => element.getClientRects().length > 0;
  const inputs = [...document.querySelectorAll('input:not([type=hidden])')].filter(visible);
  const buttons = [...document.querySelectorAll('button')].filter(button => visible(button) && button.innerText.trim() === 'Войти');
  if (buttons.length !== 1) return false;
  const put = (field, value) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (code !== undefined) {
    if (!document.body.innerText.includes('Подтверждение входа') || inputs.length !== 1 || inputs[0].type === 'password') return false;
    put(inputs[0], code);
  } else {
    const passwordInput = inputs.find(input => input.type === 'password');
    const loginInput = inputs.find(input => input.type === 'email' || /электронная почта/i.test(input.placeholder));
    if (!passwordInput || !loginInput) return false;
    put(loginInput, login);
    put(passwordInput, password);
  }
  return true;
}

function submitAuthPage() {
  if (location.origin !== 'https://lk.licard.com' || location.pathname !== '/auth') return false;
  const buttons = [...document.querySelectorAll('button')].filter(button =>
    button.getClientRects().length && !button.disabled && button.innerText.trim() === 'Войти');
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
}

async function authorize(action, fields) {
  return withLicardTab(async ({ call, evaluate, url }) => {
    const dashboard = await evaluate(inspectDashboard, contract);
    if (dashboard?.amount && parseRubles(dashboard.amount) !== null) return { state: 'connected' };
    if (action === 'login') {
      if (url !== origin + '/auth') return { state: 'error' };
      const view = await evaluate(authPage);
      if (!view?.password) {
        await call('Page.navigate', { url: origin + '/auth' });
        for (let attempt = 0; attempt < 16; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          if ((await evaluate(authPage).catch(() => null))?.password) break;
        }
      }
    } else {
      const view = await evaluate(authPage);
      if (!view?.code || view.expired) return { state: 'expired' };
    }
    if (!await evaluate(fillAuthPage, fields) || !await evaluate(submitAuthPage)) return { state: 'error' };
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const view = await evaluate(authPage).catch(() => null);
      if (action === 'login' && view?.code && !view.expired) return { state: 'code_required' };
      if (view?.expired) return { state: 'expired' };
      const dashboard = await evaluate(inspectDashboard, contract).catch(() => null);
      if (dashboard?.amount && parseRubles(dashboard.amount) !== null) return { state: 'connected' };
    }
    return { state: action === 'login' ? 'login_failed' : 'invalid_code' };
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const watchdog = setTimeout(() => process.exit(1), 25000);
  try {
    const action = process.argv[2];
    let result;
    if (action === 'login' || action === 'code') {
      let input = '';
      for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk;
      result = await authorize(action, JSON.parse(input));
    } else {
      result = await readDashboard();
    }
    console.log(JSON.stringify(result));
  } catch {
    console.log(JSON.stringify({ state: 'error' }));
  } finally {
    clearTimeout(watchdog);
  }
}
