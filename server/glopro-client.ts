import type { CabinetAccount } from '../web/src/cabinet-model';

export class GloProError extends Error {
  constructor(readonly kind: 'auth' | 'transport' | 'format', message: string) { super(message); }
}
const origin = 'https://lk.glopro.ru';
const invalid = () => new GloProError('format', 'GloPro изменил формат данных. Последний остаток сохранён; требуется проверка подключения.');
const authError = () => new GloProError('auth', 'GloPro требует повторного входа или подтверждения. Проверьте доступ в личном кабинете.');
export function htmlText(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
export function parseGloProContracts(html: string) {
  const name = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const select = html.match(/<select\b[^>]*name=["']suppliers_contracts_list["'][^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (!name || select === undefined) throw invalid();
  const contracts = [...select.matchAll(/<option\b([\s\S]*?)<\/option>/gi)].map(match => {
    const id = match[1].match(/\bvalue=["'](\d+)["']/)?.[1];
    const label = match[1].match(/\bdata-content="([\s\S]*?)"/)?.[1];
    if (!id || !label) throw invalid();
    const contract = htmlText(label).replace(/^Договор:\s*/, '');
    if (!contract || contract.length > 300) throw invalid();
    return { id, contract };
  });
  if (!contracts.length || new Set(contracts.map(x => x.id)).size !== contracts.length) throw invalid();
  const supplier = htmlText(name);
  if (!supplier || supplier.length > 300) throw invalid();
  return { supplier, contracts };
}
export function parseGloProBalance(html: string): Pick<CabinetAccount, 'amountMinor' | 'currency' | 'sourceUpdatedAt'> {
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const parts = clean.split('Баланс р/с:');
  if (parts.length !== 2) throw invalid();
  const amounts = [...parts[1].matchAll(/<span\b[^>]*class="[^"]*font-20 font-weight-bold[^"]*"[^>]*>([^<]+)<\/span>\s*<i\b[^>]*>на\s+(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})<\/i>/g)];
  // Do not combine multiple source balances or silently take the first one.
  if (amounts.length !== 1) throw invalid();
  const [, raw, day, month, year, time] = amounts[0];
  const amount = htmlText(raw).replace(/[\s\u00a0\u202f]/g, '').match(/^(-?)(\d+),(\d{2})₽$/);
  if (!amount) throw invalid();
  const amountMinor = (Number(amount[2]) * 100 + Number(amount[3])) * (amount[1] ? -1 : 1);
  const sourceDate = new Date(`${year}-${month}-${day}T${time}+03:00`);
  if (!Number.isSafeInteger(amountMinor) || !Number.isFinite(sourceDate.getTime())
      || sourceDate.getTime() > Date.now() + 300_000) throw invalid();
  return { amountMinor, currency: 'RUB', sourceUpdatedAt: sourceDate.toISOString() };
}

export class GloProClient {
  private cookies = new Map<string, string>();
  private authenticated = false;
  constructor(private readonly send: typeof fetch = fetch) {}
  private async request(path: string, body?: URLSearchParams, signal?: AbortSignal) {
    // This connector has no payment, editing or arbitrary-URL capability.
    if (!['/', '/login', '/suppliers', '/suppliers/suppliers-list/'].includes(path)
        && !/^\/suppliers\/(?:\d+|contract\/\d+)$/.test(path)) throw invalid();
    try {
      const response = await this.send(origin + path, { method: body ? 'POST' : 'GET', redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]),
        headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: origin + '/', 'X-Requested-With': 'XMLHttpRequest' } : {}) }, body });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], i = pair.indexOf('=');
        if (i > 0 && /^[\w-]+$/.test(pair.slice(0, i))) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      if (response.status === 401 || response.status === 403 || (path !== '/login' && response.status >= 300 && response.status < 400)) throw authError();
      if (path === '/login' && response.status === 302) {
        const target = new URL(response.headers.get('location') || '', origin);
        if (target.origin !== origin || target.pathname !== '/' || !this.cookies.size) throw authError();
        await response.body?.cancel(); return '';
      }
      if (!response.ok) throw new GloProError('transport', 'GloPro временно недоступен. Последний остаток сохранён.');
      const reader = response.body?.getReader(); if (!reader) throw invalid();
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw invalid(); chunks.push(value); } }
      finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString('utf8');
      if ((path !== '/' && /<form[^>]*(?:id=["']login["']|action=["']\/login["'])/i.test(text)) || path === '/login') throw authError();
      return text;
    } catch (error) {
      if (error instanceof GloProError) { if (error.kind === 'auth') { this.authenticated = false; this.cookies.clear(); } throw error; }
      throw new GloProError('transport', 'Не удалось загрузить остатки GloPro. Последние данные сохранены; повторите позже.');
    }
  }
  async balances(credentials: { login: string; password: string }): Promise<CabinetAccount[]> {
    const signal = AbortSignal.timeout(90_000);
    if (!this.authenticated) {
      await this.request('/', undefined, signal);
      await this.request('/login', new URLSearchParams(credentials), signal);
      this.authenticated = true;
    }
    const supplierIds = new Set<string>();
    let offset = 0;
    for (let page = 0; ; page++) {
      if (page >= 20) throw invalid();
      const params = new URLSearchParams({ offset: String(offset), search: '' });
      params.append('statuses_contract[]', '1'); params.append('statuses_contract[]', '10');
      let result;
      try { result = JSON.parse(await this.request('/suppliers/suppliers-list/', params, signal)); }
      catch (error) { if (error instanceof GloProError) throw error; throw invalid(); }
      if (!result?.success || !Array.isArray(result.data?.items)) throw invalid();
      const items = result.data.items;
      for (const item of items) {
        const id = String(item.ID ?? '');
        if (!/^\d+$/.test(id) || supplierIds.has(id) || supplierIds.size >= 100) throw invalid();
        supplierIds.add(id);
      }
      if (!result.data.more) break;
      const count = result.data.count ?? items.length;
      if (!Number.isSafeInteger(count) || count <= 0) throw invalid();
      offset += count;
    }
    if (!supplierIds.size) throw new GloProError('format', 'В GloPro не найдены поставщики с действующими договорами. Остатки не обновлены.');
    const accounts: CabinetAccount[] = [];
    for (const supplierId of supplierIds) {
      const detail = parseGloProContracts(await this.request(`/suppliers/${supplierId}`, undefined, signal));
      for (const contract of detail.contracts) {
        if (accounts.length >= 200) throw invalid();
        const balance = parseGloProBalance(await this.request(`/suppliers/contract/${contract.id}`, new URLSearchParams({ tab: 'contract' }), signal));
        accounts.push({ id: `${supplierId}:${contract.id}`, supplier: detail.supplier, contract: contract.contract, ...balance });
      }
    }
    return accounts;
  }
}
