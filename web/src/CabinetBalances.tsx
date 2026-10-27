import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Building2, ExternalLink, LockKeyhole, Plus, RefreshCw, X } from 'lucide-react';
import { cabinetProviders as providerDefinitions, type CabinetConnection, type CabinetProvider, type CabinetResponse } from './cabinet-model';
import { useDialogMotion } from './useDialogMotion';
import './cabinet-balances.css';
import { ourOrganizationDisplayName } from './our-organizations';
import { cabinetConnectionDisplayName, cabinetConnectionStale } from './cabinet-model';

const cabinetProviders = providerDefinitions.map(provider => provider.id === 'natcar' ? { ...provider, name: 'Национальный перевозчик' } : provider);

async function request<T>(options?: RequestInit, path = '/api/cabinets'): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось получить данные кабинетов.');
  return body;
}
const automatic = (provider: CabinetProvider) => ['glopro', 'natcar', 'rosneft'].includes(provider);
export default function CabinetBalances() {
  const [data, setData] = useState<CabinetResponse | null>(null), [error, setError] = useState('');
  const [editor, setEditor] = useState<CabinetProvider | 'choose' | null>(null), [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState<string[]>([]);
  const [organizationEditor, setOrganizationEditor] = useState<CabinetConnection | null>(null);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    try { const result = await request<CabinetResponse>({ signal: pending.signal }); if (!pending.signal.aborted) { setData(result); setError(''); } }
    catch (reason) { if (!pending.signal.aborted) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 20_000); return () => { clearInterval(timer); controller.current?.abort(); }; }, [refresh]);
  const synchronize = async (id: string) => {
    if (syncing.includes(id)) return;
    setSyncing(current => [...current, id]); setError('');
    try { await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, `/api/cabinets/${id}/sync`); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось обновить остатки.'); }
    finally { setSyncing(current => current.filter(item => item !== id)); }
  };
  const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const money = (amount: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount / 100);
  const available = cabinetProviders.filter(provider => !data?.connections.some(connection => connection.provider === provider.id));
  return <section className="cabinet-page" aria-label="Балансы кабинетов">
    <header className="cabinet-intro">
      <button className="button primary" disabled={!data?.credentialStorageReady} onClick={() => setEditor('choose')}><Plus size={18}/>Добавить кабинет</button>
    </header>
    {notice && <p role="status" className="soft-notice">{notice}</p>}
    {error && <div role="alert" className="soft-notice">{error} <button className="button" onClick={() => void refresh()}>Повторить</button></div>}
    {!data && !error && <p role="status">Загружаем подключения…</p>}
    {data && <>
      {!data.credentialStorageReady && <p className="soft-notice"><LockKeyhole size={16} aria-hidden="true"/> Сохранение доступов пока недоступно: требуется настройка защиты на сервере.</p>}
      <div className="cabinet-layout"><div className="cabinet-connected">
        <div className="cabinet-section-heading"><h3>Ваши кабинеты</h3><span>{data.connections.length}</span></div>
        {!data.connections.length && <div className="panel cabinet-empty"><Building2 size={32}/><h3>Добавьте первый кабинет</h3><p>Выберите сервис и укажите данные для входа. Здесь появятся его счета и остатки.</p><button className="button primary" disabled={!data.credentialStorageReady} onClick={() => setEditor('choose')}><Plus size={16}/>Добавить кабинет</button></div>}
        {cabinetProviders.filter(provider => data.connections.some(connection => connection.provider === provider.id)).map(provider => <article className="panel cabinet-card" key={provider.id} aria-label={provider.name}>
          <header className="cabinet-provider-header"><div className="cabinet-provider-title"><ProviderMark provider={provider.id}/><h3>{provider.name}</h3></div><a className="cabinet-external" href={provider.url} target="_blank" rel="noopener noreferrer">Открыть сайт<ExternalLink size={15}/></a></header>
          {data.connections.filter(connection => connection.provider === provider.id).map(connection => {
            const stale = cabinetConnectionStale(connection);
            const hasAccounts = !!connection.accounts?.length;
            return <section className="cabinet-connection" key={connection.id} aria-label={cabinetConnectionDisplayName(connection)}>
              <div className="cabinet-connection-heading"><span>Кабинет · {cabinetConnectionDisplayName(connection)}</span><span className={`cabinet-status ${hasAccounts && !stale ? 'is-current' : 'is-pending'}`}>{hasAccounts ? stale ? 'Данные требуют обновления' : 'Остатки обновлены' : automatic(provider.id) ? 'Ожидаем обновление' : 'Доступ сохранён'}</span></div>
              {hasAccounts ? <div className="cabinet-accounts">{connection.accounts!.map(account => <div className="cabinet-account" key={account.id}>
                <div className="cabinet-account-info"><strong>{ourOrganizationDisplayName(account.organization || account.supplier)}</strong>{account.organization && account.supplier !== account.organization && <span>{provider.id === 'natcar' ? provider.name : ourOrganizationDisplayName(account.supplier)}</span>}</div>
                <div className="cabinet-account-balance"><strong className={`cabinet-account-amount${account.amountMinor < 0 ? ' is-negative' : ''}`}>{money(account.amountMinor)}</strong>{account.sourceUpdatedAt && <span>Данные {provider.name} на {date(account.sourceUpdatedAt)} МСК</span>}{account.balanceLabel && !/^баланс р\/[сc]$/iu.test(account.balanceLabel) && <span>{account.balanceLabel}</span>}</div>
              </div>)}</div> : <p className="cabinet-pending">{automatic(provider.id) ? 'Остатки ещё не получены. Первое обновление — в течение минуты после добавления.' : 'Автоматическое получение остатков пока недоступно. Доступ сохранён для настройки подключения.'}</p>}
              {connection.error && <p className="cabinet-sync-error" role="status">{connection.error}</p>}
              <footer className="cabinet-connection-footer"><span>{connection.lastSuccessAt ? `${stale ? 'Последнее обновление' : 'Обновлено'} ${date(connection.lastSuccessAt)} МСК` : 'Успешных обновлений пока нет'}</span><div>
                {provider.id === 'natcar' && <button className="button cabinet-organizations-button" disabled={syncing.includes(connection.id)} onClick={() => setOrganizationEditor(connection)}><Building2 size={16}/>Организации</button>}
                {automatic(provider.id) && <button className="button cabinet-refresh" aria-label={syncing.includes(connection.id) ? 'Обновление…' : 'Обновить'} title="Обновить остатки" aria-busy={syncing.includes(connection.id)} disabled={syncing.includes(connection.id)} onClick={() => void synchronize(connection.id)}><RefreshCw size={15} aria-hidden="true"/><span>{syncing.includes(connection.id) ? 'Обновление…' : 'Обновить'}</span></button>}
              </div></footer>
            </section>;
          })}
        </article>)}
      </div><aside className="cabinet-sidebar" aria-label="Добавление кабинетов">
        <div className="panel cabinet-help"><span className="cabinet-eyebrow">ПОДКЛЮЧЕНИЕ</span><h3>Как добавить кабинет</h3><ol><li>Выберите сервис.</li><li>Введите название, логин и пароль.</li><li>После подключения здесь появятся остатки.</li></ol><p>У GloPro, Роснефти и Национального перевозчика остатки загружаются автоматически. Для Яндекс Go и ЛУКОЙЛ пока можно только сохранить доступ.</p><p className="cabinet-security"><LockKeyhole size={16}/>Данные для входа хранятся в зашифрованном виде.</p></div>
        {!!available.length && <div className="panel cabinet-available"><h3>Другие сервисы</h3>{available.map(provider => <div className="cabinet-available-item" key={provider.id}><div className="cabinet-provider-title"><ProviderMark provider={provider.id}/><strong>{provider.name}</strong></div><p>{automatic(provider.id) ? 'Автоматическое обновление остатков' : 'Получение остатков пока недоступно'}</p><button className="button" disabled={!data.credentialStorageReady} onClick={() => setEditor(provider.id)}><Plus size={16}/>{automatic(provider.id) ? 'Добавить кабинет' : 'Сохранить доступ'}</button></div>)}</div>}
      </aside></div>
    </>}
    {editor && <ConnectionEditor initialProvider={editor === 'choose' ? null : editor} onClose={() => setEditor(null)} onSaved={provider => { setEditor(null); setNotice(automatic(provider) ? 'Кабинет добавлен. Первое обновление остатков начнётся в течение минуты.' : 'Доступ сохранён. Получение остатков этого сервиса ещё не подключено.'); void refresh(); }}/>}
    {organizationEditor && <OrganizationEditor connection={organizationEditor} onClose={() => setOrganizationEditor(null)} onSaved={() => { setOrganizationEditor(null); setNotice('Состав организаций сохранён. Обновите остатки или дождитесь автоматического обновления.'); void refresh(); }}/>}
  </section>;
}

function ProviderMark({ provider }: { provider: CabinetProvider }) {
  return <span className={`cabinet-provider-mark provider-${provider}`} aria-hidden="true">{{ glopro: 'G', yandex: 'Я', licard: 'Л', rosneft: 'Р', natcar: 'Н' }[provider]}</span>;
}

function OrganizationFields({ value, onChange, disabled }: { value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  return <fieldset className="cabinet-organizations" disabled={disabled}><legend>Организации в этом кабинете</legend><p>Укажите названия так, как они записаны в кабинете Национального перевозчика. Загружаться будут только их счета.</p>
    {value.map((name, index) => <div className="cabinet-organization-row" key={index}><label><span>Организация {index + 1}</span><input required maxLength={300} value={name} placeholder="Название организации" onChange={event => onChange(value.map((item, i) => i === index ? event.target.value : item))}/></label><button type="button" className="icon-button" aria-label={`Убрать организацию ${index + 1}`} disabled={value.length === 1} onClick={() => onChange(value.filter((_, i) => i !== index))}><X size={18}/></button></div>)}
    <button type="button" className="button" disabled={value.length >= 20} onClick={() => onChange([...value, ''])}><Plus size={16}/>Добавить организацию</button>
  </fieldset>;
}

function OrganizationEditor({ connection, onClose, onSaved }: { connection: CabinetConnection; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), busy = useRef(false);
  const [organizations, setOrganizations] = useState(connection.organizationNames?.length ? [...connection.organizationNames] : ['']);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const motion = useDialogMotion(dialog, onClose);
  const close = () => { if (!busy.current) motion.close(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError('');
    try {
      await request({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationNames: organizations.map(name => name.trim()).filter(Boolean), expectedOrganizationNames: connection.organizationNames }) }, `/api/cabinets/${connection.id}/organizations`);
      await motion.complete(onSaved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить организации.'); }
    finally { busy.current = false; setSaving(false); }
  };
  return <dialog ref={dialog} className="cabinet-dialog" aria-labelledby="cabinet-organizations-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={submit}>
    <header><h2 id="cabinet-organizations-title">Организации natcar</h2><button type="button" className="icon-button" aria-label="Закрыть" onClick={close} disabled={saving}><X size={20}/></button></header>
    <p className="cabinet-dialog-description">Кабинет «{connection.label}». Логин и пароль вводить повторно не нужно.</p>
    <OrganizationFields value={organizations} onChange={setOrganizations} disabled={saving}/>
    {error && <p role="alert" className="shipment-error">{error}</p>}
    <footer><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button className="button primary" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить организации'}</button></footer>
  </form></dialog>;
}

function ConnectionEditor({ initialProvider, onClose, onSaved }: { initialProvider: CabinetProvider | null; onClose: () => void; onSaved: (provider: CabinetProvider) => void }) {
  const [provider, setProvider] = useState<CabinetProvider | null>(initialProvider);
  const entry = cabinetProviders.find(item => item.id === provider);
  const dialog = useRef<HTMLDialogElement>(null), busy = useRef(false);
  const [label, setLabel] = useState(''), [login, setLogin] = useState(''), [password, setPassword] = useState('');
  const [organizations, setOrganizations] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const motion = useDialogMotion(dialog, onClose);
  const close = () => { if (!busy.current) motion.close(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy.current || !provider) return; busy.current = true; setSaving(true); setError('');
    try {
      await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, label, login, password, ...(provider === 'natcar' ? { organizationNames: organizations.map(n => n.trim()).filter(Boolean) } : {}) }) });
      setPassword(''); setLogin(''); await motion.complete(() => onSaved(provider));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить доступ.'); }
    finally { busy.current = false; setSaving(false); }
  };
  return <dialog ref={dialog} className="cabinet-dialog" aria-labelledby="cabinet-editor-title" onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <header><h2 id="cabinet-editor-title">{entry ? `Добавить кабинет ${entry.name}` : 'Добавить кабинет'}</h2><button type="button" className="icon-button" aria-label="Закрыть" onClick={close} disabled={saving}><X size={20}/></button></header>
      {!entry || !provider ? <><p className="cabinet-dialog-description">Шаг 1 из 2 · Выберите сервис</p><div className="cabinet-provider-options">{cabinetProviders.map(item => <button type="button" className="cabinet-provider-option" key={item.id} onClick={() => setProvider(item.id)}><ProviderMark provider={item.id}/><span><strong>{item.name}</strong><small>{automatic(item.id) ? 'Автоматическая загрузка остатков' : 'Сохранение доступа · остатки пока недоступны'}</small></span><ArrowRight size={18}/></button>)}</div></> : <>
      <button type="button" className="cabinet-back" disabled={saving} onClick={() => { setProvider(null); setLogin(''); setPassword(''); setError(''); }}><ArrowLeft size={15}/>Выбрать другой сервис</button>
      <p className="cabinet-dialog-description">Шаг 2 из 2 · Данные для входа в {entry.name}</p>
      {!automatic(provider) && <p className="cabinet-pending">Получение остатков пока недоступно. Сейчас можно сохранить доступ для дальнейшей настройки.</p>}
      <label>Название кабинета<input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="Например, НК АРТЭЛЬ" disabled={saving}/></label>
      {provider === 'natcar' && <OrganizationFields value={organizations} onChange={setOrganizations} disabled={saving}/>}
      <label>Логин<input required maxLength={320} autoComplete="off" autoCapitalize="none" spellCheck={false} value={login} onChange={event => setLogin(event.target.value)} disabled={saving}/></label>
      <label>Пароль<input required maxLength={4096} type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={saving}/></label>
      <p className="cabinet-hint cabinet-security"><LockKeyhole size={15} aria-hidden="true"/> Доступ сохраняется на сервере в зашифрованном виде. {automatic(provider) ? 'После сохранения сервер выполнит вход и прочитает остатки у поставщиков.' : 'Одноразовые коды здесь не нужны.'}</p>
      {error && <p role="alert" className="shipment-error">{error}</p>}
      <footer><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button className="button primary" disabled={saving}>{saving ? 'Сохранение…' : automatic(provider) ? 'Добавить кабинет' : 'Сохранить доступ'}</button></footer></>}
    </form>
  </dialog>;
}
