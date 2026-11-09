import { fuelBalance } from './balance.mjs';
const cabinet = 'https://business.taxi.yandex.ru/';
function login(url) {
  try { return /^passport\.yandex\.(ru|com)$/.test(new URL(url).hostname); } catch { return false; }
}
// Each poll gets a disposable renderer but retains the server's persistent profile.
// Only our page is closed: interactive login and unrelated tabs are untouched.
export async function readBalance(context) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let page;
    try {
      page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      const pending = page.waitForResponse(r => {
        const u = new URL(r.url());
        return u.origin === 'https://b2b-api-lk.go.yandex.ru' && u.pathname === '/corp-cabinet/3.0/contracts/list' && r.request().method() === 'GET';
      }, { timeout: 30000 });
      pending.catch(() => {});
      await page.goto(cabinet, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (login(page.url())) throw Error('auth');
      const response = await pending;
      if (response.status() === 401) throw Error('auth');
      // A forbidden response alone does not prove that the session has expired.
      if (response.status() !== 200 || response.fromServiceWorker()) throw Error('provider');
      const company = await response.request().headerValue('x-yataxi-selected-corp-client-id');
      return fuelBalance(await response.json(), company);
    } catch (error) {
      if (page && login(page.url())) throw Error('auth');
      if (['auth', 'scope', 'schema'].includes(error?.message) || attempt === 1) throw error;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}
