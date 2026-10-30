import { watchVisibleRefresh } from './visible-refresh';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, ChevronDown, Download, FileText, History, Info, LoaderCircle, LockKeyhole, Menu, RefreshCw, Settings, Sparkles, X } from 'lucide-react';
import type { AccountUser as User } from './auth-model';
import { apiFetch as fetch, sessionExpiredEvent } from './workspace-api';
import { useDialogMotion } from './useDialogMotion';
import { InvoiceBuyerSearch as BuyerSearch } from './InvoiceBuyerSearch';
import { calculateQuantity, calculateRoundedInvoice, normalizePositiveDecimal, type Quantity, type RoundedInvoiceCalculation } from './invoice-math';
import './invoices.css';
const expireSession = () => window.dispatchEvent(new Event(sessionExpiredEvent));
type PriceSettings = { defaultUnitPrice: string | null; revision: number; updatedAt: string | null; updatedBy: string | null };
type Job = { calculation?: RoundedInvoiceCalculation; requestedAmount?: string; id: string; status: 'queued' | 'processing' | 'ready' | 'uncertain' | 'failed'; amount: string; unitPrice: string; organizationName: string; buyerName: string; createdAt: string; fileAvailable: boolean; error?: string; quantity: Quantity; workflowState?: string; number?: string | null; remoteRef?: string | null; canRetryPdf?: boolean; canRetryValidation?: boolean; needsReconciliation?: boolean };
type IntegrationStatus = 'not_configured' | 'configured' | 'read_only' | 'unavailable';
type Integration = { status: IntegrationStatus; message?: string; checkedAt?: string | null; baseLabel?: string | null };
type CatalogEntry = { id: string; name: string; connectionId?: string; inn?: string };
type ConnectionStatus = { id: string; baseId: string | null; baseLabel: string; status: 'ready' | 'unavailable'; checkedAt: string; counts: { organizations: number; buyers: number } };
type InvoiceProfile = {
  revision: string; sourceNumber: string; sourceDate: string; observedAt: string;
  organizationId: string; connectionId?: string; organizationName: string; productName: string; unit: string;
  currency: 'RUB'; vatRate: string; vatMode: 'included'; sampleUnitPrice: string;
  bankLabel: string; bankDiffersFromDefault: boolean; postedAsSample: boolean; qr: boolean; productSelectedByUser?: boolean; postingConfirmedByUser?: boolean; postOnCreate?: boolean;
  sourceProductName?: string; productSelectionStatus?: 'ready' | 'missing' | 'ambiguous' | 'unsupported' | 'unverified'; productSelectionMessage?: string | null;
};
type PreparationResult = {
  preview: { sourceNumber: string; sourceDate: string; observedAt: string; profileRevision: string;
    organizationId: string; organizationName: string | null; buyerId: string; buyerName: string | null;
    productName: string; unit: string; currency: 'RUB'; amount: string; unitPrice: string; quantity: Quantity;
    vatRate: string; vatMode: 'included'; vatAmount: string; netAmount: string;
    bankLabel: string | null; bankDiffersFromDefault: boolean; contract: { id: string; name: string } | null;
    preparationState: 'preliminary' | 'verified'; } | null;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  canCreate: boolean;
  verification?: 'live';
};
type InvoiceWorkspace = {
  integration?: Integration;
  invoiceProfile?: InvoiceProfile | null;
  invoiceProfiles?: InvoiceProfile[];
  invoiceCreation?: { mode: 'live'; connections: Array<{ connectionId: string; ready: boolean; checking?: boolean; blockers: Array<{ code: string; message: string }> }> };
  canPrepare?: boolean;
  organizations: CatalogEntry[];
  buyers: CatalogEntry[];
  connections?: ConnectionStatus[];
  defaultUnitPrice: string | null;
  settings: PriceSettings;
  product: { name: string; unit: string; vatRate: string; vatMode: string | null };
  canCreate: boolean;
  canEditDefaultPrice: boolean;
  history: { status: 'ready'; items: Job[] };
};
type InvoiceInput = { calculationVersion?: 1 | 2; organizationId: string; buyerId: string; amount: string; unitPrice: string; idempotencyKey: string; connectionId?: string; profileRevision?: string };
type Attempt = { state: 'unknown' | 'pending' | 'accepted'; input: InvoiceInput; job?: Job };
const jobLabels: Record<Job['status'], string> = { queued: 'В очереди', processing: 'Формируется', ready: 'Готов', uncertain: 'Нужна проверка в 1С', failed: 'Не сформирован' };
const workflowLabels: Record<string, string> = { planned: 'Проверяем реквизиты', creating: 'Создаём счёт в 1С', remote_verified: 'Счёт создан · проверяем проведение', posting: 'Проводим счёт в 1С', pdf_pending: 'Получаем PDF' };
const jobLabel = (job: Job) => job.canRetryPdf ? 'Счёт создан · PDF не получен' : job.status === 'queued' || job.status === 'processing' ? workflowLabels[job.workflowState ?? ''] ?? jobLabels[job.status] : jobLabels[job.status];
const formatDecimal = (value: string) => value.replace('.', ',');
const formatMoney = (value: string) => {
  const [whole, decimal] = value.replace(/^\+/, '').split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${decimal && /[1-9]/.test(decimal) ? `,${decimal}` : ''}`;
};
const differenceLabel = (calculation: RoundedInvoiceCalculation) => calculation.differenceCents === '0'
  ? 'Совпадает с введённой суммой'
  : `На ${formatMoney(calculation.difference.replace(/^[+-]/, ''))} ₽ ${calculation.differenceCents.startsWith('-') ? 'меньше' : 'больше'} введённой суммы`;
function CalculationDetails({ calculation, history = false }: { calculation: RoundedInvoiceCalculation; history?: boolean }) {
  return <details className="invoice-calculation-details"><summary><Info size={16} aria-hidden="true" /><span>Как рассчитано</span><ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="invoice-detail-steps">
      <div><p className="invoice-step-name"><span>1</span>Вы ввели</p><p className="invoice-detail-value">{formatMoney(calculation.requestedAmount)} ₽ · {formatMoney(calculation.unitPrice)} ₽/л</p><p className="field-hint">Исходная сумма и цена за литр</p></div>
      <div><p className="invoice-step-name"><span>2</span>Округляем литры</p><p className="invoice-detail-value">{formatDecimal(calculation.exactQuantityDisplay)} → {formatDecimal(calculation.quantity)} л</p><p className="field-hint">Сумма ÷ цена. До ближайшего целого; половину литра округляем вверх.</p></div>
      <div><p className="invoice-step-name"><span>3</span>Пересчитываем сумму</p><p className="invoice-detail-value">{formatDecimal(calculation.quantity)} × {formatMoney(calculation.unitPrice)} ₽ = {formatMoney(calculation.amount)} ₽</p><p className="field-hint">Цена за литр остаётся прежней</p></div>
    </div><p className="invoice-detail-result">{differenceLabel(calculation)}. <strong>{history ? 'Сумма счёта' : 'В счёт пойдёт'} {formatMoney(calculation.amount)} ₽.</strong></p>
  </details>;
}
function CalculationPreview({ calculation }: { calculation: RoundedInvoiceCalculation }) {
  return <div className="invoice-calculation" aria-label="Расчёт счёта"><div className="invoice-calculation-main" aria-live="polite" aria-atomic="true">
    <div><span className="invoice-small-label">Количество</span><strong data-invoice-quantity>{formatDecimal(calculation.quantity)} <span>л</span></strong></div>
    <span className="invoice-math-symbol" aria-hidden="true">×</span>
    <div className="invoice-calculation-price"><span className="invoice-small-label">Цена за литр</span><strong>{formatMoney(calculation.unitPrice)} <span>₽</span></strong></div>
    <span className="invoice-math-symbol invoice-equals" aria-hidden="true">=</span>
    <div className="invoice-calculation-total"><span className="invoice-small-label">Итого к оплате</span><strong data-invoice-total>{formatMoney(calculation.amount)} <span>₽</span></strong><span className="invoice-difference">{differenceLabel(calculation)}</span></div>
  </div><CalculationDetails calculation={calculation} /></div>;
}
const readableDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); };

async function responseError(response: Response, fallback: string): Promise<string> {
  try { const body: { error?: unknown } = await response.json(); return typeof body.error === 'string' ? body.error : fallback; } catch { return fallback; }
}
type InvoiceDraft = { organizationId: string; buyerId: string; amount: string; unitPrice: string; priceEdited: boolean };
const draftKey = (userId: string) => `artel:crm:invoice-draft:${encodeURIComponent(userId)}`;
function readDraft(userId: string): InvoiceDraft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey(userId)) || 'null');
    if (draft && ['organizationId', 'buyerId', 'amount', 'unitPrice'].every(key => typeof draft[key] === 'string' && draft[key].length < 256) && typeof draft.priceEdited === 'boolean') return draft;
  } catch { /* No saved unsent draft. */ }
  return null;
}
function Loading({ children }: { children: string }) { return <div className="loading-state" role="status"><LoaderCircle size={21} className="spinner" aria-hidden="true" /><span>{children}</span></div>; }
function Retry({ error, retry }: { error: string; retry: () => void }) { return <div className="error-state"><p role="alert">{error}</p><button type="button" className="button secondary" onClick={retry}><RefreshCw size={17} aria-hidden="true" />Повторить</button></div>; }
function ProfileSummary({ profile }: { profile: InvoiceProfile }) {
  return <div className="invoice-profile-summary"><p className="profile-source">Реквизиты по счёту №{profile.sourceNumber} от {profile.sourceDate.split('-').reverse().join('.')}</p><dl><div><dt>Продавец</dt><dd>{profile.organizationName}</dd></div><div><dt>Позиция нового счёта</dt><dd>{profile.productName}</dd></div>{profile.sourceProductName && profile.sourceProductName !== profile.productName && <div><dt>Позиция исходного счёта</dt><dd>{profile.sourceProductName}</dd></div>}<div><dt>Условия</dt><dd>{profile.unit} · {profile.currency} · НДС {profile.vatRate}% в сумме</dd></div><div><dt>Банк образца</dt><dd>{profile.bankLabel}</dd></div><div><dt>Состояние</dt><dd>{profile.postedAsSample ? 'Образец проведён в 1С' : 'Образец сохранён в 1С'}</dd></div><div><dt>Печатная форма</dt><dd>{profile.qr ? 'С QR-кодом в образце' : 'Без QR-кода в образце'}</dd></div></dl>{profile.productSelectionStatus && profile.productSelectionStatus !== 'ready' && <p className="field-hint">{profile.productSelectionMessage ?? 'Позиция нового счёта ещё не подтверждена в этой базе.'}</p>}{profile.postingConfirmedByUser && <p className="field-hint">{profile.postOnCreate ? 'Новый счёт будет проведён по вашему выбору.' : 'Новый счёт будет сохранён без проведения по вашему выбору.'}</p>}{profile.bankDiffersFromDefault && <p className="field-hint">Банк образца отличается от основного банка организации. Для проверки используется банк образца.</p>}</div>;
}
const attemptPrefix = (userId: string) => `artel:crm:invoice-pending:${encodeURIComponent(userId)}:`;
const attemptStorageKey = (userId: string, input: InvoiceInput) => `${attemptPrefix(userId)}${encodeURIComponent(input.idempotencyKey)}`;
function parseAttempt(raw: string | null): Attempt | null {
  try {
    const value = JSON.parse(raw || 'null');
    const input = value?.input;
    if (input && ['organizationId', 'buyerId', 'amount', 'unitPrice', 'idempotencyKey'].every(key => typeof input[key] === 'string' && input[key].length > 0 && input[key].length < 256)
      && (input.calculationVersion === undefined || input.calculationVersion === 1 || input.calculationVersion === 2)
      && ['connectionId', 'profileRevision'].every(key => input[key] === undefined || typeof input[key] === 'string' && input[key].length > 0 && input[key].length < 256)) return { state: 'unknown', input };
  } catch { /* Invalid stored drafts are not requests. */ }
  return null;
}
function savedAttempts(userId: string): Attempt[] {
  const attempts = new Map<string, Attempt>();
  try {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(attemptPrefix(userId))).sort()) {
      const attempt = parseAttempt(localStorage.getItem(key));
      if (attempt && key === attemptStorageKey(userId, attempt.input)) attempts.set(attempt.input.idempotencyKey, attempt);
    }
  } catch { /* Sending still requires a successful durable write. */ }
  try {
    const legacy = parseAttempt(sessionStorage.getItem(`artel:crm:invoice-pending:${userId}`));
    if (legacy && !attempts.has(legacy.input.idempotencyKey)) attempts.set(legacy.input.idempotencyKey, legacy);
  } catch { /* A legacy tab store may be unavailable. */ }
  return [...attempts.values()];
}
function persistAttempt(userId: string, input: InvoiceInput) {
  const key = attemptStorageKey(userId, input), raw = JSON.stringify({ input });
  const previous = localStorage.getItem(key);
  // An immutable per-request record never replaces another tab's unresolved
  // request. The owner lock also prevents two tabs starting new work together.
  if (previous && JSON.stringify(parseAttempt(previous)?.input) !== JSON.stringify(input)) throw new Error('Stored request differs.');
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error('Request was not saved.');
}
function migrateAttempt(userId: string) {
  const key = `artel:crm:invoice-pending:${userId}`;
  const raw = sessionStorage.getItem(key), legacy = parseAttempt(raw);
  if (!legacy) return;
  persistAttempt(userId, legacy.input);
  if (sessionStorage.getItem(key) === raw) sessionStorage.removeItem(key);
}
function forgetAttempt(userId: string, input: InvoiceInput) {
  const key = attemptStorageKey(userId, input);
  if (JSON.stringify(parseAttempt(localStorage.getItem(key))?.input) === JSON.stringify(input)) localStorage.removeItem(key);
  const legacyKey = `artel:crm:invoice-pending:${userId}`;
  if (JSON.stringify(parseAttempt(sessionStorage.getItem(legacyKey))?.input) === JSON.stringify(input)) sessionStorage.removeItem(legacyKey);
}
export default function InvoicePage({ user, menuOpen, onOpenMenu }: { user: User; menuOpen: boolean; onOpenMenu: () => void }) {
  const onSessionExpired = expireSession;
  const [draft] = useState(() => readDraft(user.id));
  const id = useId(); const [initialAttempt] = useState(() => savedAttempts(user.id)[0] ?? null);
  const settingsDialog = useRef<HTMLDialogElement>(null); const historyPanel = useRef<HTMLElement>(null); const historyRequested = useRef(new URLSearchParams(location.search).get('invoiceView') === 'history'); const [data, setData] = useState<InvoiceWorkspace | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const { open: openSettingsDialog, close: closeSettings, complete: completeSettings } = useDialogMotion(settingsDialog, undefined, false);
  const [organizationId, setOrganizationId] = useState(initialAttempt?.input.organizationId ?? draft?.organizationId ?? ''); const [buyerId, setBuyerId] = useState(initialAttempt?.input.buyerId ?? draft?.buyerId ?? ''); const [amount, setAmount] = useState(initialAttempt?.input.amount ?? draft?.amount ?? ''); const [price, setPrice] = useState(initialAttempt?.input.unitPrice ?? draft?.unitPrice ?? '');
  const [preparing, setPreparing] = useState(false); const [preparation, setPreparation] = useState<PreparationResult | null>(null); const [preparationError, setPreparationError] = useState(''); const preparationRequest = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(initialAttempt); const [invoiceError, setInvoiceError] = useState(''); const [recoveryNotice, setRecoveryNotice] = useState(''); const [downloadId, setDownloadId] = useState(''); const [downloadError, setDownloadError] = useState(''); const [retryId, setRetryId] = useState(''); const [retryError, setRetryError] = useState('');
  const selectedOrganization = data?.organizations.find(company => company.id === organizationId);
  const invoiceProfiles = data?.invoiceProfiles ?? (data?.invoiceProfile ? [data.invoiceProfile] : []);
  const selectedProfile = invoiceProfiles.find(profile => profile.organizationId === organizationId) ?? (!organizationId ? invoiceProfiles[0] ?? null : null);
  const organizationAvailable = Boolean(selectedOrganization);
  const availableBuyers = data?.buyers.filter(buyer => data.connections === undefined || (selectedOrganization?.connectionId && buyer.connectionId === selectedOrganization.connectionId)) ?? [];
  const buyerAvailable = availableBuyers.some(buyer => buyer.id === buyerId);
  const priceEdited = useRef(Boolean(initialAttempt) || Boolean(draft?.priceEdited)); const latestSettings = useRef<PriceSettings | null>(null); const request = useRef<AbortController | null>(null); const requests = useRef(new Set<AbortController>()); const activeAttempt = useRef<Attempt | null>(initialAttempt); const mounted = useRef(true); const submitting = useRef(false);
  const showAttempt = useCallback((next: Attempt | null) => {
    activeAttempt.current = next; setAttempt(next);
    if (next) { priceEdited.current = true; setOrganizationId(next.input.organizationId); setBuyerId(next.input.buyerId); setAmount(next.input.amount); setPrice(next.input.unitPrice); }
  }, []);
  useEffect(() => {
    try { migrateAttempt(user.id); } catch { /* The original record remains available; sending will fail closed. */ }
    const onStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(attemptPrefix(user.id)) || activeAttempt.current) return;
      const saved = savedAttempts(user.id)[0];
      if (saved) { showAttempt(saved); setRecoveryNotice('Восстановлен незавершённый запрос этого аккаунта из другой вкладки.'); }
    };
    window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage);
  }, [showAttempt, user.id]);
  useEffect(() => {
    const openHistory = () => {
      const focusHistory = () => { historyPanel.current?.scrollIntoView({ block: 'start' }); historyPanel.current?.focus({ preventScroll: true }); };
      if (settingsDialog.current?.open) void completeSettings(focusHistory);
      else focusHistory();
    };
    window.addEventListener('artel:invoice-history', openHistory);
    return () => window.removeEventListener('artel:invoice-history', openHistory);
  }, [completeSettings]);
  useEffect(() => {
    if (attempt) return;
    try { sessionStorage.setItem(draftKey(user.id), JSON.stringify({ organizationId, buyerId, amount, unitPrice: price, priceEdited: priceEdited.current })); } catch { /* An unsent draft is optional; submitted requests require durable storage. */ }
  }, [user.id, organizationId, buyerId, amount, price, attempt]);
  const newController = () => { const controller = new AbortController(); requests.current.add(controller); return controller; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); for (const controller of requests.current) controller.abort(); }; }, []);
  const applySettings = useCallback((settings: PriceSettings) => {
    if (latestSettings.current && latestSettings.current.revision > settings.revision) return latestSettings.current;
    latestSettings.current = settings;
    if (!priceEdited.current) setPrice(settings.defaultUnitPrice ?? '');
    return settings;
  }, []);
  const refresh = useCallback(async (forceCatalogs = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch('/api/invoices', { cache: 'no-store', headers: { 'X-Artel-Account': user.id, ...(forceCatalogs ? { 'X-Artel-Catalog-Refresh': '1' } : {}) }, signal: controller.signal });
      if (response.status === 401) { if (!controller.signal.aborted) onSessionExpired(); return null; }
      if (!response.ok) { const message = await responseError(response, 'Не удалось загрузить счета.'); if (!controller.signal.aborted) setError(message); return null; }
      const result: InvoiceWorkspace = await response.json(); if (controller.signal.aborted) return null;
      const settings = applySettings(result.settings); const current = { ...result, settings, defaultUnitPrice: settings.defaultUnitPrice }; setData(current); setError(''); return current;
    } catch { if (!controller.signal.aborted) setError('Не удалось загрузить счета. Проверьте подключение и повторите попытку.'); return null; }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [applySettings, onSessionExpired, user.id]);
  useEffect(() => { void refresh(); const stop = watchVisibleRefresh(() => { void refresh(); }); return () => { stop(); request.current?.abort(); }; }, [refresh]);
  const hasActiveJobs = Boolean(data?.history.items.some(job => job.status === 'queued' || job.status === 'processing'));
  const hasPrintChecks = Boolean(data?.invoiceCreation?.connections.some(connection => connection.checking));
  useEffect(() => {
    if (!hasActiveJobs && !hasPrintChecks) return; let stopped = false; let timeout: ReturnType<typeof setTimeout>; let interval = hasActiveJobs ? 1500 : 3000;
    const poll = async () => { if (document.visibilityState === 'visible') await refresh(); if (!stopped) { interval = Math.min(interval * 1.5, 12000); timeout = setTimeout(() => void poll(), interval); } };
    timeout = setTimeout(() => void poll(), interval); return () => { stopped = true; clearTimeout(timeout); };
  }, [hasActiveJobs, hasPrintChecks, refresh]);
  useEffect(() => {
    preparationRequest.current?.abort(); preparationRequest.current = null;
    setPreparation(null); setPreparationError(''); setPreparing(false);
  }, [organizationId, buyerId, organizationAvailable, buyerAvailable, amount, price, selectedProfile?.revision]);
  useEffect(() => {
    // Only an unsent draft follows the refreshed catalog. A submitted request
    // keeps its original input and key even if its catalog entries disappear.
    if (!data || activeAttempt.current) return;
    if (organizationId && !organizationAvailable) setOrganizationId('');
    if (buyerId && !buyerAvailable) setBuyerId('');
  }, [data, organizationId, buyerId, organizationAvailable, buyerAvailable, attempt]);
  useEffect(() => {
    if (data && historyRequested.current) { historyRequested.current = false; historyPanel.current?.scrollIntoView({ block: 'start' }); historyPanel.current?.focus({ preventScroll: true }); }
  }, [data]);
  const prepareInvoice = async () => {
    if (preparing || !data?.canPrepare || !selectedProfile) return;
    let body;
    try {
      if (!organizationAvailable || !buyerAvailable) throw new Error('Выберите продавца и покупателя из доступных справочников.');
      calculateRoundedInvoice(amount, price);
      body = { calculationVersion: 2, organizationId, buyerId, ...(selectedOrganization?.connectionId ? { connectionId: selectedOrganization.connectionId } : {}), amount: normalizePositiveDecimal(amount), unitPrice: normalizePositiveDecimal(price), profileRevision: selectedProfile.revision };
    } catch (error) { setPreparationError((error as Error).message); return; }
    const controller = newController(); preparationRequest.current = controller;
    setPreparing(true); setPreparation(null); setPreparationError('');
    try {
      const response = await fetch('/api/invoices/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Artel-Account': user.id }, body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onSessionExpired(); return; }
      if (!response.ok) { const message = await responseError(response, 'Не удалось проверить данные счёта.'); if (!controller.signal.aborted) setPreparationError(message); return; }
      const result: PreparationResult = await response.json(); if (!controller.signal.aborted) setPreparation(result);
    } catch { if (!controller.signal.aborted) setPreparationError('Не удалось выполнить проверку. Проверьте подключение и повторите попытку.'); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted) setPreparing(false); if (preparationRequest.current === controller) preparationRequest.current = null; }
  };
  const startNextInvoice = () => {
    const saved = savedAttempts(user.id)[0];
    showAttempt(saved ?? null); setInvoiceError(''); setRecoveryNotice(saved ? 'Восстановлен следующий незавершённый запрос. Сначала проверьте его результат.' : '');
    if (!saved) { setAmount(''); setOrganizationId(''); setBuyerId(''); priceEdited.current = false; setPrice(data?.defaultUnitPrice ?? ''); }
  };
  const createInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || (!canSubmit && activeAttempt.current?.state !== 'unknown') || activeAttempt.current?.state === 'pending' || activeAttempt.current?.state === 'accepted') return;
    if (typeof navigator.locks?.request !== 'function') { setInvoiceError('Запрос не отправлен: браузер не поддерживает защиту от одновременной отправки из разных вкладок. Откройте приложение в современном браузере по защищённому адресу.'); return; }
    submitting.current = true;
    try {
      await navigator.locks.request(`artel:crm:invoices-submit:${user.id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!mounted.current) return;
        if (!lock) {
          if (!activeAttempt.current) showAttempt(savedAttempts(user.id)[0] ?? null);
          setInvoiceError('Запрос этого аккаунта сейчас отправляется в другой вкладке. Дождитесь ответа там или проверьте прежний запрос позже.'); return;
        }
        let input = activeAttempt.current?.input;
        try {
          migrateAttempt(user.id);
          // Recheck while holding the owner lock: another tab may have saved an
          // unresolved request after this form was rendered. Recover it first.
          const saved = savedAttempts(user.id)[0];
          if (!input && saved) { showAttempt(saved); setRecoveryNotice('Восстановлен незавершённый запрос из другой вкладки. Проверьте его результат перед новым счётом.'); return; }
          if (!input) {
            if (!organizationAvailable || !buyerAvailable) throw new Error('Выберите продавца и покупателя из доступных справочников.');
            calculateRoundedInvoice(amount, price);
            input = { calculationVersion: 2, organizationId, buyerId, amount: normalizePositiveDecimal(amount), unitPrice: normalizePositiveDecimal(price), idempotencyKey: crypto.randomUUID(), ...(data?.invoiceCreation?.mode === 'live' ? { connectionId: selectedOrganization?.connectionId, profileRevision: selectedProfile?.revision } : {}) };
          }
          persistAttempt(user.id, input);
        } catch { setInvoiceError('Запрос не отправлен: не удалось надёжно сохранить его для защиты от повторного создания. Проверьте введённые данные и разрешите хранилище сайта.'); return; }
        const submittedInput = input;
        showAttempt({ state: 'pending', input: submittedInput }); setInvoiceError(''); setRecoveryNotice('');
        const controller = newController(); const timeout = setTimeout(() => controller.abort(), 30000);
        const unresolved = () => showAttempt({ state: 'unknown', input: submittedInput });
        const resolveAttempt = (accepted: Attempt | null) => {
          try { forgetAttempt(user.id, submittedInput); } catch { /* A retained record safely replays the same key later. */ }
          const remaining = savedAttempts(user.id).find(item => item.input.idempotencyKey !== submittedInput.idempotencyKey);
          showAttempt(remaining ?? accepted);
          if (remaining) setRecoveryNotice(accepted ? 'Предыдущий запрос принят. Восстановлен следующий незавершённый запрос; проверьте его результат.' : 'Восстановлен следующий незавершённый запрос; проверьте его результат.');
        };
        try {
          const response = await fetch('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Artel-Account': user.id }, body: JSON.stringify(submittedInput), signal: controller.signal });
          if (!mounted.current) return;
          if (controller.signal.aborted) throw new Error('Request timed out.');
          if (response.status === 401) { unresolved(); onSessionExpired(); return; }
          if (!response.ok) {
            const message = await responseError(response, 'Не удалось подтвердить создание счёта.');
            if (!mounted.current) return;
            if (controller.signal.aborted) throw new Error('Request timed out.');
            if (response.status === 400 || response.status === 422) resolveAttempt(null); else unresolved();
            setInvoiceError(message); return;
          }
          const body: { job: Job } = await response.json();
          if (response.status !== 202 || typeof body.job?.id !== 'string' || !body.job.id) throw new Error('Invalid acceptance response');
          if (!mounted.current) return;
          if (controller.signal.aborted) throw new Error('Request timed out.');
          try { sessionStorage.removeItem(draftKey(user.id)); } catch { /* The server owns accepted history. */ }
          resolveAttempt({ state: 'accepted', input: submittedInput, job: body.job });
          setData(current => current ? { ...current, history: { status: 'ready', items: [body.job, ...current.history.items.filter(job => job.id !== body.job.id)] } } : current); void refresh();
        } catch { if (mounted.current) { unresolved(); setInvoiceError('Ответ не получен. Повторная проверка использует тот же запрос и не создаёт второй счёт.'); } }
        finally { clearTimeout(timeout); requests.current.delete(controller); }
      });
    } catch { if (mounted.current) setInvoiceError('Не удалось защитить отправку от повторного создания. Проверьте прежний запрос или откройте приложение заново.'); }
    finally { submitting.current = false; }
  };
  const retryJob = async (job: Job) => {
    if (retryId || (!job.canRetryPdf && !job.needsReconciliation && !job.canRetryValidation)) return;
    setRetryId(job.id); setRetryError(''); const controller = newController();
    try {
      const response = await fetch(`/api/invoices/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Artel-Account': user.id }, body: '{}', signal: controller.signal });
      if (response.status === 401) { onSessionExpired(); return; }
      if (!response.ok) { setRetryError(await responseError(response, 'Не удалось запустить проверку.')); return; }
      await refresh();
    } catch { if (!controller.signal.aborted) setRetryError('Ответ не получен. Обновите историю, чтобы проверить состояние счёта.'); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted) setRetryId(''); }
  };
  const download = async (job: Job) => {
    if (downloadId) return; setDownloadId(job.id); setDownloadError(''); const controller = newController();
    try {
      const response = await fetch(`/api/invoices/jobs/${encodeURIComponent(job.id)}/file`, { cache: 'no-store', headers: { 'X-Artel-Account': user.id }, signal: controller.signal });
      if (response.status === 401) { onSessionExpired(); return; }
      if (!response.ok) { setDownloadError(await responseError(response, 'Не удалось скачать PDF. Обновите историю и повторите попытку.')); return; }
      if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('Not a PDF');
      const blob = await response.blob(); if (controller.signal.aborted) return; const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `Счёт-${(job.number || job.id).replace(/[^а-яА-ЯёЁa-zA-Z0-9_-]/g, '')}.pdf`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (!controller.signal.aborted) setDownloadError('Не удалось скачать PDF. Проверьте подключение и повторите попытку.'); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted) setDownloadId(''); }
  };
  const openSettings = (event: { currentTarget: HTMLButtonElement }) => { event.currentTarget.focus(); openSettingsDialog(); };
  const legacyAttempt = Boolean(attempt && attempt.input.calculationVersion !== 2);
  let quantity: Quantity | null = null; let calculation: RoundedInvoiceCalculation | null = null; let quantityError = '';
  if (amount && price) { try {
    if (legacyAttempt) quantity = calculateQuantity(amount, price);
    else { calculation = calculateRoundedInvoice(amount, price); quantity = { display: calculation.quantity, numerator: calculation.quantity, denominator: '1', exact: true }; }
  } catch (error) { quantityError = (error as Error).message; } }
  const profile = selectedProfile;
  const profileMatchesSeller = Boolean(profile && profile.organizationId === organizationId);
  const liveMode = data?.invoiceCreation?.mode === 'live';
  const selectedCreation = data?.invoiceCreation?.connections.find(connection => connection.connectionId === selectedOrganization?.connectionId);
  const canSubmit = Boolean(data?.canCreate && (!liveMode || (profileMatchesSeller && selectedOrganization?.connectionId === profile?.connectionId && selectedCreation?.ready && !selectedCreation.checking && !selectedCreation.blockers.length && (!profile?.productSelectionStatus || profile.productSelectionStatus === 'ready'))));
  const submittedJob = attempt?.job ? data?.history.items.find(job => job.id === attempt.job?.id) ?? attempt.job : null;
  const acceptedNotice = submittedJob?.canRetryPdf ? 'Счёт создан в 1С. Получение PDF можно повторить в истории.' : submittedJob?.status === 'ready' ? 'Счёт готов. PDF доступен в вашей истории.' : submittedJob?.status === 'uncertain' ? 'Ответ 1С не подтверждён. Проверьте статус в истории перед новой отправкой.' : submittedJob?.status === 'failed' ? 'Счёт не сформирован. Причина указана в истории.' : `Запрос принят. ${submittedJob ? jobLabel(submittedJob) : 'Формируем счёт и PDF'}. Работа продолжится в фоне; результат появится в вашей истории.`;
  const integration = data?.integration;
  const integrationStatus = integration?.status ?? 'not_configured';
  const integrationLabels: Record<IntegrationStatus, string> = { not_configured: 'Подключение не настроено', read_only: 'Справочники подключены', unavailable: 'Справочники недоступны', configured: 'Доступ к 1С настроен' };
  const integrationFallbacks: Record<IntegrationStatus, string> = {
    not_configured: 'Подключение к 1С ещё не настроено. Формирование счетов и PDF пока недоступно.',
    read_only: 'Доступно чтение справочников 1С. Формирование счетов и PDF ещё не включено.',
    unavailable: 'Не удалось получить справочники 1С. Обновите данные, чтобы проверить подключение.',
    configured: 'Параметры подключения к 1С настроены.',
  };
  const integrationMessage = integration?.message || integrationFallbacks[integrationStatus] || 'Состояние подключения пока не получено.';
  const catalogsConnected = integrationStatus === 'read_only' || integrationStatus === 'configured';
  const checkedAtLabel = integration?.checkedAt ? readableDate(integration.checkedAt) : '';
  const emptyCatalogMessage = catalogsConnected ? 'В справочниках нет доступных продавцов или покупателей. Обновите данные в настройках.' : integrationStatus === 'unavailable' ? 'Справочники сейчас недоступны. Проверьте статус 1С в настройках.' : 'Справочники появятся после подключения 1С.';
  const formLocked = Boolean(attempt); const loadState = !data ? loading ? <Loading>Загружаем данные…</Loading> : <Retry error={error} retry={() => void refresh()} /> : null;
  const preparationWaitedForPrint = Boolean(preparation?.blockers.some(issue => issue.code === 'pdf_checking'));
  const creationBlockers = [...new Map((preparationWaitedForPrint
    ? [...(preparation?.blockers.filter(issue => issue.code !== 'pdf_checking') ?? []), ...(selectedCreation?.blockers ?? [])]
    : preparation?.blockers.length ? preparation.blockers : selectedCreation?.blockers ?? []).map(issue => [issue.code, issue])).values()];
  const firstBlocker = creationBlockers.find(issue => !['pdf_unconfigured', 'remote_write_unconfigured'].includes(issue.code)) ?? creationBlockers[0];
  const preparationStatus = preparation?.canCreate && preparation.verification === 'live' && (!liveMode || selectedCreation?.ready) && !selectedCreation?.checking ? 'Данные проверены в 1С. Можно сформировать счёт.'
    : selectedCreation?.checking ? 'Проверяем печать в 1С. Это может занять несколько минут.'
    : firstBlocker ? `Проверка выполнена. ${firstBlocker.message}`
    : preparationWaitedForPrint && selectedCreation?.ready ? 'Печать проверена. Проверьте данные счёта перед созданием.'
    : 'Расчёт проверен. Создание ещё не подключено.';
  const creationHint = formLocked ? '' : firstBlocker?.message
    ?? (liveMode && selectedOrganization && !profile ? 'Для продавца ещё не подтверждены реквизиты нового счёта.'
      : liveMode && selectedCreation?.checking ? 'Проверяем печать в 1С. Это может занять несколько минут.'
      : !canSubmit ? integrationMessage : 'Проверим реквизиты, создадим счёт и получим PDF. После принятия запроса работа продолжится в фоне.');
  return <section className="invoice-workspace" aria-label="Счета">
    <div className="invoice-topbar page-heading page-heading-compact"><h1>Счета</h1><button className="icon-button page-menu" type="button" aria-label="Открыть меню" aria-controls="app-navigation" aria-expanded={menuOpen} onClick={onOpenMenu}><Menu size={22} aria-hidden="true" /></button>
      <div className="invoice-toolbar" role="group" aria-label="Действия со счетами"><button className="button mobile-icon-action" type="button" aria-label="Обновить счета" title="Обновить счета" disabled={loading} onClick={() => void refresh()}><RefreshCw size={18} aria-hidden="true" className={loading ? 'spinner' : ''}/><span className="mobile-action-label">Обновить</span></button><button className="button mobile-icon-action" type="button" aria-label="Настройки счетов" title="Настройки счетов" aria-haspopup="dialog" onClick={openSettings}><Settings size={18} aria-hidden="true"/><span className="mobile-action-label">Настройки</span></button></div>
    </div>
    {data && error && <Retry error={error} retry={() => void refresh()} />}

    <section className="panel invoice-create-panel create-panel" id={`${id}-panel-create`} aria-labelledby={`${id}-create-heading`}>
      <header className="panel-heading"><div><h2 id={`${id}-create-heading`}>Новый счёт</h2><p className="field-hint">Выберите компании и укажите сумму — литры рассчитаются автоматически.</p></div></header>
      {loadState || (data && <form className="invoice-form" id={`${id}-invoice-form`} onSubmit={event => void createInvoice(event)}>
        <label className="field seller-field" htmlFor={`${id}-organization`}><span>Продавец</span>
          <select id={`${id}-organization`} value={organizationId} onChange={event => { const next = data.organizations.find(company => company.id === event.target.value); if (next?.connectionId !== selectedOrganization?.connectionId) setBuyerId(''); setOrganizationId(event.target.value); }} disabled={!data.organizations.length || formLocked} required>
            <option value="">{data.organizations.length ? 'Выберите продавца' : catalogsConnected ? 'Нет доступных продавцов' : integrationStatus === 'unavailable' ? 'Продавцы недоступны' : 'Продавцы не подключены'}</option>
            {data.organizations.map(company => <option key={company.id} value={company.id}>{company.name}{data.connections && data.connections.length > 1 ? ` · ${data.connections.find(connection => connection.id === company.connectionId)?.baseLabel ?? '1С Fresh'}` : ''}</option>)}
          </select>
        </label>
        <BuyerSearch key={selectedOrganization?.connectionId ?? 'legacy-catalog'} buyers={availableBuyers} value={buyerId} onChange={setBuyerId}
          disabled={!availableBuyers.length || formLocked || Boolean(data.connections && !selectedOrganization)}
          placeholder={data.connections && !selectedOrganization ? 'Сначала выберите продавца' : availableBuyers.length ? 'Название или ИНН' : catalogsConnected ? 'Нет доступных покупателей' : integrationStatus === 'unavailable' ? 'Покупатели недоступны' : 'Покупатели не подключены'} />
        {(!data.organizations.length || !data.buyers.length) && <p className="inline-note"><Building2 size={17} aria-hidden="true" /><span>{emptyCatalogMessage}</span></p>}
          <label className="field amount-field" htmlFor={`${id}-amount`}><span id={`${id}-amount-label`}>{legacyAttempt ? 'Сумма счёта' : 'Сумма до округления'}</span><span className="invoice-money-input"><input id={`${id}-amount`} aria-labelledby={`${id}-amount-label`} type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Введите сумму" maxLength={32} disabled={formLocked} required /><span aria-hidden="true">₽</span></span></label>
          <label className="field invoice-price" htmlFor={`${id}-price`}><span id={`${id}-price-label`}>Цена за литр</span><span className="invoice-money-input"><input id={`${id}-price`} aria-labelledby={`${id}-price-label`} type="text" inputMode="decimal" autoComplete="off" value={price} onChange={event => { priceEdited.current = true; setPrice(event.target.value); }} placeholder="Не задана" maxLength={32} disabled={formLocked} required aria-describedby={`${id}-price-hint`} /><span aria-hidden="true">₽/л</span></span></label>
        <div className="price-context"><p className="field-hint invoice-rounding-note"><Sparkles size={15} aria-hidden="true" />{legacyAttempt ? 'Сохранённый запрос: прежний расчёт без изменений' : 'Округляем до ближайшего целого литра'}</p><div><p className="field-hint" id={`${id}-price-hint`}>{priceEdited.current ? 'Индивидуальная цена этого счёта.' : data.defaultUnitPrice === null ? 'Укажите цену за литр.' : 'Сохранённая цена. Можно изменить для этого счёта.'}</p>
          {priceEdited.current && data.defaultUnitPrice !== null && !formLocked && <button type="button" className="text-button" onClick={() => { priceEdited.current = false; setPrice(data.defaultUnitPrice ?? ''); }}>Вернуть общую</button>}
        </div>
        </div>
        {data.defaultUnitPrice === null && profileMatchesSeller && profile && <button type="button" className="text-button sample-price-button" disabled={formLocked} onClick={() => { priceEdited.current = true; setPrice(profile.sampleUnitPrice); }}>Взять цену из образца: {formatDecimal(profile.sampleUnitPrice)} руб./л</button>}
        {calculation && <CalculationPreview calculation={calculation} />}
        {legacyAttempt && <p className="notice">Этот запрос создан до изменения округления. Проверка сохранит исходную сумму, количество и прежний ключ запроса.</p>}
        {quantityError && <p className="form-error" role="alert">{quantityError}</p>}
        <div className="create-action">
          {attempt?.state === 'accepted' ? <><p className="notice" role="status">{acceptedNotice}</p><button type="button" className="button secondary" onClick={startNextInvoice}>Начать новый счёт</button></> : <>
            {!liveMode && !attempt && data.canPrepare && profileMatchesSeller && <button type="button" className="button secondary" onClick={() => void prepareInvoice()} disabled={preparing || !organizationAvailable || !buyerAvailable || !quantity}>
              {preparing && <LoaderCircle size={18} className="spinner" aria-hidden="true" />}{preparing ? 'Проверяем данные…' : 'Проверить данные счёта'}
            </button>}
            {preparationError && <p className="form-error" role="alert">{preparationError}</p>}
            {preparation && !attempt && <p className="preparation-status" role="status">{preparationStatus}</p>}
            <button className="button primary" type="submit" disabled={(!canSubmit && attempt?.state !== 'unknown') || attempt?.state === 'pending' || (!attempt && (!organizationAvailable || !buyerAvailable || !quantity))} aria-describedby={`${id}-create-hint`}>
              {attempt?.state === 'pending' ? <LoaderCircle size={18} className="spinner" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}{attempt?.state === 'pending' ? liveMode ? 'Проверяем реквизиты…' : 'Отправляем запрос…' : attempt?.state === 'unknown' ? 'Проверить прежний запрос' : liveMode ? 'Создать счёт и PDF' : 'Сформировать счёт'}
            </button>
            {attempt?.state === 'unknown' && <p className="notice" role="status">Ответ ещё не подтверждён. Повторная проверка использует прежние данные и защищает от дубликата.</p>}
          </>}
          <div className="creation-guidance" id={`${id}-create-hint`}>
            {!preparation && creationHint && <p className="field-hint">{creationHint}</p>}
            {!formLocked && (creationBlockers.length > 0 || preparation?.warnings.length || liveMode && selectedOrganization && !profile) && <button type="button" className="text-button" onClick={openSettings}>Что нужно настроить</button>}
          </div>
          {attempt?.state === 'pending' && <p className="notice" role="status">Проверяем реквизиты и передаём запрос. Дождитесь подтверждения, что запрос принят.</p>}
          {recoveryNotice && <p className="notice" role="status">{recoveryNotice}</p>}
          {invoiceError && <p className="form-error" role="alert">{invoiceError}</p>}
        </div>
      </form>)}
    </section>
    <section className="panel invoice-history-panel" id={`${id}-panel-history`} aria-labelledby={`${id}-history-heading`} tabIndex={-1} ref={historyPanel}>
      <header className="panel-heading"><div><div className="invoice-history-title"><h2 id={`${id}-history-heading`}>История счетов</h2>{data && <span className="invoice-history-count">{data.history.items.length}</span>}</div><p className="field-hint">Ваши счета и готовые документы — в одном месте.</p></div></header>
      {data ? data.history.items.length ? <div className="history-list">
        {downloadError && <p className="form-error" role="alert">{downloadError}</p>}{retryError && <p className="form-error" role="alert">{retryError}</p>}
        {data.history.items.map(job => <article className="history-item" key={job.id} data-invoice-job={job.id}>
          <header><span className="invoice-history-number">{job.number ? `Счёт №${job.number}` : 'Новый счёт'}</span><time dateTime={job.createdAt}>{readableDate(job.createdAt)}</time><span className={`job-status status-${job.status}`}>{jobLabel(job)}</span></header>
          <dl className="invoice-history-values"><div className="invoice-history-buyer"><dt>Покупатель</dt><dd><strong>{job.buyerName}</strong><span>От {job.organizationName}</span></dd></div><div><dt>Количество</dt><dd>{formatDecimal(job.quantity.display)} л</dd></div><div className="invoice-history-price"><dt>Цена за литр</dt><dd>{formatMoney(job.unitPrice)} ₽</dd></div><div className="invoice-history-sum"><dt>Сумма счёта</dt><dd>{formatMoney(job.amount)} ₽</dd></div></dl>
          {job.error && <p className="form-error">{job.error}</p>}{job.status === 'uncertain' && <p className="field-hint">Результат операции в 1С ещё не подтверждён. Сначала проверьте состояние этого счёта.</p>}
          {job.calculation?.version === 2 && <CalculationDetails calculation={job.calculation} history />}
          <div className="invoice-history-actions">{!job.calculation && <p className="field-hint invoice-legacy-note">Сохранён с прежним расчётом</p>}
            {(job.canRetryPdf || job.needsReconciliation || job.canRetryValidation) && <button type="button" className="button secondary" onClick={() => void retryJob(job)} disabled={Boolean(retryId)}>{retryId === job.id ? <LoaderCircle size={17} className="spinner" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}{job.canRetryPdf ? 'Повторить получение PDF' : job.canRetryValidation ? 'Повторить проверку' : 'Проверить счёт в 1С'}</button>}
            {job.fileAvailable && <button type="button" className="button secondary download-button" onClick={() => void download(job)} disabled={Boolean(downloadId)}>{downloadId === job.id ? <LoaderCircle className="spinner" size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}Скачать PDF</button>}
          </div>
        </article>)}
      </div> : <div className="empty-state"><span className="section-symbol"><History size={27} aria-hidden="true" /></span><h3>Пока нет счетов</h3><p>Здесь будут только ваши счета и PDF.</p></div> : <p className="field-hint invoice-history-loading">{loading ? 'Загружаем историю…' : 'История пока недоступна.'}</p>}
      <footer className="invoice-history-footer"><LockKeyhole size={13} aria-hidden="true" />Эту историю видите только вы</footer>
    </section>
    <dialog ref={settingsDialog} onCancel={event => { event.preventDefault(); closeSettings(); }} className="invoice-settings-dialog" aria-labelledby={`${id}-settings-heading`} onClick={event => { if (event.target === event.currentTarget) closeSettings(); }}><header className="invoice-dialog-heading"><div><p className="field-hint">Счета</p><h2 id={`${id}-settings-heading`}>Настройки</h2></div><button type="button" className="icon-button" aria-label="Закрыть настройки" onClick={closeSettings}><X size={20} aria-hidden="true" /></button></header><div className="invoice-dialog-body">{loadState}{preparation && (creationBlockers.length > 0 || preparation.warnings.length > 0) && <div className="settings-section preparation-details"><h2>Проверка текущего счёта</h2><ul>{[...creationBlockers, ...preparation.warnings].map(issue => <li className="field-hint" key={issue.code}>{issue.message}</li>)}</ul><button type="button" className="text-button" onClick={closeSettings}>Вернуться к счёту</button></div>}<div className="settings-section integration-section"><h2>1С Fresh</h2>{data ? <><p className={`integration-state integration-${integrationStatus}`}><span aria-hidden="true" />{integrationLabels[integrationStatus] || 'Статус не определён'}</p>{integration?.baseLabel && <p className="field-hint integration-base">База: <strong>{integration.baseLabel}</strong></p>}<p className="field-hint">{integrationMessage}</p>{integrationStatus === 'read_only' && <p className="field-hint">Справочники доступны для выбора. Ниже показано, что требуется для формирования счетов в каждой базе.</p>}{data.connections && data.connections.length > 0 && <ul className="connection-list" aria-label="Подключённые базы">{data.connections.map(connection => <li key={connection.id}><strong>{connection.baseLabel}</strong><p className="field-hint">{connection.status === 'ready' ? `Доступна · продавцов: ${connection.counts.organizations}, контрагентов: ${connection.counts.buyers}` : 'Недоступна · записи этой базы нельзя выбрать'}</p>{data.invoiceCreation?.connections.find(item => item.connectionId === connection.id)?.blockers.map(issue => <p className="field-hint" key={issue.code}>{issue.message}</p>)}<p className="field-hint">Проверено: <time dateTime={connection.checkedAt}>{readableDate(connection.checkedAt)}</time></p></li>)}</ul>}{checkedAtLabel && <p className="field-hint integration-checked">Проверено: <time dateTime={integration?.checkedAt ?? undefined}>{checkedAtLabel}</time></p>}<button type="button" className="button secondary refresh-catalogs" onClick={() => void refresh(true)} disabled={loading}>{loading ? <LoaderCircle size={18} className="spinner" aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}{loading ? 'Обновляем справочники…' : 'Обновить справочники'}</button></> : <p className="field-hint">{loading ? 'Проверяем состояние подключения…' : 'Состояние подключения пока не получено.'}</p>}</div>{profile && <div className="settings-section"><h2>Реквизиты нового счёта</h2><ProfileSummary profile={profile} /><p className="field-hint">Перед отправкой программа повторно проверяет реквизиты в 1С. Доступность формирования указана выше для каждой базы.</p></div>}</div></dialog>
  </section>;
}
