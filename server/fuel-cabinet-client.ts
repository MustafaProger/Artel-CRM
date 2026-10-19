import Decimal from 'decimal.js';
import type { CabinetAccount } from '../web/src/cabinet-model';
import { htmlText } from './glopro-client';

type Provider = 'natcar' | 'rosneft';
export class FuelCabinetError extends Error {
  constructor(readonly kind: 'auth' | 'transport' | 'format', message: string) { super(message); }
}
const names = { natcar: 'natcar', rosneft: 'Роснефть' };
const origins = { natcar: 'https://lk.natcar.ru', rosneft: 'https://lk.rn-card.ru' };
const invalid = (provider: Provider) => new FuelCabinetError('format', `${names[provider]}: состав счетов или формат остатка изменился. Последние данные сохранены.`);
const auth = (provider: Provider) => new FuelCabinetError('auth', `${names[provider]} требует проверки доступа или подтверждения входа. Автоматические попытки остановлены.`);
const text = (value: string) => htmlText(value.replace(/&#x([a-f\d]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))));
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1];
function hidden(html: string, name: string, provider: Provider) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => m[0]).filter(tag => attribute(tag, 'name') === name);
  const value = inputs.length === 1 ? attribute(inputs[0], 'value') : undefined;
  if (!value) throw invalid(provider);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2B;/gi, '+');
}
export function fuelMoney(value: unknown, provider: Provider): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid(provider);
  const raw = String(value).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) throw invalid(provider);
  const minor = new Decimal(raw).mul(100);
  if (!minor.isInteger() || !Number.isSafeInteger(minor.toNumber())) throw invalid(provider);
  return minor.toNumber();
}
export function normalizeCabinetOrganization(value: string) {
  return value.toLocaleUpperCase('ru').replace(/^\s*ООО\s*/, '').replace(/[«»"'\s-]/g, '');
}
export function parseNatcarBalances(value: unknown, organizationNames: string[]): CabinetAccount[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || !organizationNames.length) throw invalid('natcar');
  const expected = new Set(organizationNames.map(normalizeCabinetOrganization));
  if (expected.size !== organizationNames.length || expected.has('')) throw invalid('natcar');
  const found = new Set<string>(), ids = new Set<string>(), accounts: CabinetAccount[] = [];
  for (const row of value) {
    if (!row || typeof row.name !== 'string') throw invalid('natcar');
    const normalized = normalizeCabinetOrganization(row.name);
    if (!expected.has(normalized)) continue; // Access to another customer's account is not ownership.
    if (!Number.isSafeInteger(row.pk) || row.pk <= 0 || ids.has(String(row.pk)) || row.name.length > 300
      || (row.contract_name !== null && (typeof row.contract_name !== 'string' || !row.contract_name || row.contract_name.length > 300))) throw invalid('natcar');
    ids.add(String(row.pk)); found.add(normalized);
    accounts.push({ id: `natcar:${row.pk}`, supplier: 'natcar', organization: row.name,
      ...(row.contract_name ? { contract: row.contract_name } : {}), amountMinor: fuelMoney(row.ballance_with_discount, 'natcar'), currency: 'RUB', balanceLabel: 'Текущий баланс' });
  }
  if (found.size !== expected.size || !accounts.length || accounts.length > 200) throw invalid('natcar');
  return accounts;
}
export function parseRosneftContracts(html: string) {
  const select = html.match(/<select\b[^>]*id="contract-list-box"[^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (!select) throw invalid('rosneft');
  const contracts = [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(([, attrs, label]) => {
    const id = attribute(attrs, 'value'), contract = text(label);
    if (!id || !/^\d+$/.test(id) || !contract || contract.length > 300) throw invalid('rosneft');
    return { id, contract, selected: /\bselected(?:\s|=|$)/i.test(attrs) };
  });
  if (!contracts.length || contracts.length > 50 || new Set(contracts.map(c => c.id)).size !== contracts.length || contracts.filter(c => c.selected).length !== 1) throw invalid('rosneft');
  return contracts;
}
export function parseRosneftBalance(html: string, id: string): CabinetAccount {
  html = html.replace(/&#x([a-f\d]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
  const contracts = parseRosneftContracts(html), selected = contracts.find(c => c.selected);
  if (!selected || selected.id !== id) throw invalid('rosneft');
  const start = html.indexOf('<div id="balance-widget-container"');
  if (start < 0 || html.indexOf('<div id="balance-widget-container"', start + 1) !== -1) throw invalid('rosneft');
  const widget = html.slice(start).split('<div class="card"')[0];
  const matches = [...widget.matchAll(/<div\b[^>]*class="currency-RUR"[^>]*>([^<]+)<\/div>/g)];
  if (matches.length !== 1) throw invalid('rosneft');
  const details = ['Собственные средства', 'Заблокировано', 'Неснижаемый остаток'].map(label => {
    const matches = [...widget.matchAll(new RegExp(`${label}\\s*</div>\\s*<div[^>]*>\\s*([^<]+)\\s*</div>`, 'g'))];
    if (matches.length !== 1) throw invalid('rosneft');
    return { label, amountMinor: fuelMoney(text(matches[0][1]), 'rosneft') };
  });
  return { id: `rosneft:${id}`, supplier: 'Роснефть', contract: selected.contract, amountMinor: fuelMoney(text(matches[0][1]), 'rosneft'), currency: 'RUB', balanceLabel: 'Баланс', details };
}

/** Only the provider's observed sign-in and balance-reading routes. No financial writes. */
export class FuelCabinetClient {
  private cookies = new Map<string, { name: string; value: string; path: string; expires: number }>();
  private authenticated = false;
  constructor(readonly provider: Provider, private readonly send: typeof fetch = fetch) {}
  private async request(path: string, signal: AbortSignal, body?: URLSearchParams | string, login = false) {
    const allowed = this.provider === 'natcar'
      ? ((!body && ['/company/', '/company/api/', '/login/?next=/company/'].includes(path)) || (body instanceof URLSearchParams && path === '/login/?next=/company/'))
      : ((!body && ['/', '/Account/Login?ReturnUrl=%2F'].includes(path)) || (body instanceof URLSearchParams && path === '/Account/Login?returnurl=%2F&handler=Login') || (typeof body === 'string' && /^\d+$/.test(body) && path === '/api/LK/v1/ChangeContractListBoxItem'));
    if (!allowed) throw invalid(this.provider);
    const origin = origins[this.provider];
    try {
      const response = await this.send(origin + path, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        headers: { Cookie: [...this.cookies.values()].filter(c => c.expires > Date.now() && path.startsWith(c.path)).map(c => `${c.name}=${c.value}`).join('; '),
          ...(body ? { Origin: origin, Referer: origin + (this.provider === 'natcar' ? '/login/?next=/company/' : '/Account/Login?ReturnUrl=%2F'), 'Content-Type': typeof body === 'string' ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' } : {}) }, body });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...parts] = header.split(';'), i = pair.indexOf('='), attrs = parts.map(p => p.trim());
        const name = pair.slice(0, i), value = pair.slice(i + 1), domain = attrs.find(p => /^domain=/i.test(p))?.slice(7).replace(/^\./, '');
        if (i <= 0 || !/^[\w.-]+$/.test(name) || (domain && domain !== new URL(origin).hostname)) continue;
        const cookiePath = attrs.find(p => /^path=/i.test(p))?.slice(5) ?? '/';
        const age = attrs.find(p => /^max-age=/i.test(p))?.slice(8), expiration = attrs.find(p => /^expires=/i.test(p))?.slice(8);
        const expires = age !== undefined ? Date.now() + Number(age) * 1000 : expiration ? Date.parse(expiration) : Infinity;
        this.cookies.set(`${cookiePath}:${name}`, { name, value, path: cookiePath, expires });
      }
      if (response.status >= 300 && response.status < 400) {
        const target = new URL(response.headers.get('location') || '', origin);
        await response.body?.cancel();
        if (login && [302, 303].includes(response.status) && target.href === origin + (this.provider === 'natcar' ? '/company/' : '/')) return '';
        throw auth(this.provider);
      }
      if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw auth(this.provider); }
      if (!response.ok) { await response.body?.cancel(); throw new FuelCabinetError('transport', `${names[this.provider]} временно недоступен. Последние данные сохранены.`); }
      const reader = response.body?.getReader(); if (!reader) throw invalid(this.provider);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 3_000_000) throw invalid(this.provider); chunks.push(value); } }
      finally { await reader.cancel(); }
      const html = Buffer.concat(chunks).toString('utf8');
      if (login || ((!path.includes('Login') && !path.startsWith('/login/')) && /<input\b[^>]*type=["']password["']/i.test(html))) throw auth(this.provider);
      return html;
    } catch (error) {
      if (error instanceof FuelCabinetError) throw error;
      throw new FuelCabinetError('transport', `Не удалось загрузить остатки ${names[this.provider]} по HTTPS. Последние данные сохранены.`);
    }
  }
  async balances(credentials: { login: string; password: string }, organizationNames: string[] = []): Promise<CabinetAccount[]> {
    const signal = AbortSignal.timeout(90_000);
    try {
      if (!this.authenticated) {
        const path = this.provider === 'natcar' ? '/login/?next=/company/' : '/Account/Login?ReturnUrl=%2F';
        const html = await this.request(path, signal);
        if (/class=["'][^"']*g-recaptcha|name=["']g-recaptcha-response/i.test(html)) throw auth(this.provider);
        const body = this.provider === 'natcar'
          ? new URLSearchParams({ csrfmiddlewaretoken: hidden(html, 'csrfmiddlewaretoken', this.provider), username: credentials.login, password: credentials.password, next: '/company/' })
          : new URLSearchParams({ __RequestVerificationToken: hidden(html, '__RequestVerificationToken', this.provider), Login: credentials.login, Password: credentials.password, IsPersistent: 'true' });
        await this.request(this.provider === 'natcar' ? path : '/Account/Login?returnurl=%2F&handler=Login', signal, body, true);
        this.authenticated = true;
      }
      if (this.provider === 'natcar') {
        const raw = await this.request('/company/api/', signal);
        let value: unknown; try { value = JSON.parse(raw); } catch { throw invalid('natcar'); }
        return parseNatcarBalances(value, organizationNames);
      }
      let html = await this.request('/', signal);
      const contracts = parseRosneftContracts(html), accounts: CabinetAccount[] = [];
      for (const contract of contracts) {
        if (!parseRosneftContracts(html).some(c => c.id === contract.id && c.selected)) {
          await this.request('/api/LK/v1/ChangeContractListBoxItem', signal, contract.id);
          html = await this.request('/', signal);
        }
        if (JSON.stringify(parseRosneftContracts(html).map(c => c.id).sort()) !== JSON.stringify(contracts.map(c => c.id).sort())) throw invalid('rosneft');
        accounts.push(parseRosneftBalance(html, contract.id));
      }
      return accounts;
    } catch (error) {
      if (error instanceof FuelCabinetError && error.kind === 'auth') { this.authenticated = false; this.cookies.clear(); }
      throw error;
    }
  }
}
