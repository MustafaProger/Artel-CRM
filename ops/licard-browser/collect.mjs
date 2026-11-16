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

async function readDashboard() {
  const response = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) });
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
    const read = async () => {
      const { result } = await call('Runtime.evaluate', {
        expression: '(' + inspectDashboard.toString() + ')(' + JSON.stringify(contract) + ')',
        returnByValue: true,
      });
      return result?.value;
    };
    const initial = await read();
    if (initial?.auth) return { state: 'auth_required' };
    await call('Page.enable');
    if (tabs[0].url === origin + '/') await call('Page.reload', { ignoreCache: true });
    else await call('Page.navigate', { url: origin + '/' });
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const view = await read().catch(() => null);
      if (view?.auth) return { state: 'auth_required' };
      const amountMinor = view?.loadedAt !== initial?.loadedAt && view?.amount ? parseRubles(view.amount) : null;
      if (amountMinor !== null) return { state: 'connected', amountMinor };
    }
    return { state: 'error' };
  } finally {
    ws.close();
  }
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

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const watchdog = setTimeout(() => process.exit(1), 25000);
  try { console.log(JSON.stringify(await readDashboard())); }
  catch { console.log(JSON.stringify({ state: 'error' })); }
  finally { clearTimeout(watchdog); }
}
