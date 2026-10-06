/** Server-provisioned authorization for future saves. Contains certificate IDs, never private keys. */
export interface SabyAutomaticSigningParty { inn: string; kpp: string; thumbprint: string }
export interface SabyAutomaticSigningPolicy {
  id: string;
  enabled: boolean;
  approvedAt: string;
  mode: 'deferred';
  sender: SabyAutomaticSigningParty;
  carrier: SabyAutomaticSigningParty;
}
const error = 'Настройка автоматического подписания Saby некорректна. Автоматическая отправка выключена.';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
function party(value: unknown): SabyAutomaticSigningParty | undefined {
  if (!object(value) || !exactKeys(value, ['inn', 'kpp', 'thumbprint']) || typeof value.inn !== 'string' || !/^\d{10}$/.test(value.inn) || typeof value.kpp !== 'string' || !/^\d{9}$/.test(value.kpp) || typeof value.thumbprint !== 'string') return;
  const thumbprint = value.thumbprint.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[a-f0-9]{40,128}$/.test(thumbprint)) return;
  return { inn: value.inn, kpp: value.kpp, thumbprint };
}
export function readAutomaticSigningPolicy(raw: string | undefined): { policy?: SabyAutomaticSigningPolicy; error?: string } {
  if (raw === undefined || !raw.trim()) return {};
  try {
    if (raw.length > 4096) return { error };
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !exactKeys(value, ['id', 'enabled', 'approvedAt', 'mode', 'sender', 'carrier']) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.id) || typeof value.enabled !== 'boolean' || value.mode !== 'deferred' || typeof value.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.approvedAt) || !Number.isFinite(Date.parse(value.approvedAt))) return { error };
    const sender = party(value.sender), carrier = party(value.carrier);
    if (!sender || !carrier || sender.inn === carrier.inn || sender.thumbprint === carrier.thumbprint) return { error };
    return { policy: { id: value.id, enabled: value.enabled, approvedAt: value.approvedAt, mode: 'deferred', sender, carrier } };
  } catch { return { error }; }
}
export function automaticSigningPolicyMatchesOrganizations(policy: SabyAutomaticSigningPolicy, config: { customer: { inn: string; kpp: string }; carrier: { inn: string; kpp: string } }): boolean {
  return policy.sender.inn === config.customer.inn && policy.sender.kpp === config.customer.kpp && policy.carrier.inn === config.carrier.inn && policy.carrier.kpp === config.carrier.kpp;
}
export function automaticSigningCapability(config: { automaticSigning?: SabyAutomaticSigningPolicy; automaticSigningError?: string; customer: { inn: string; kpp: string }; carrier: { inn: string; kpp: string } }): { enabled: boolean; message?: string } {
  if (config.automaticSigningError) return { enabled: false, message: config.automaticSigningError };
  if (!config.automaticSigning?.enabled) return { enabled: false };
  if (!automaticSigningPolicyMatchesOrganizations(config.automaticSigning, config)) return { enabled: false, message: 'Организации автоматического подписания не совпадают с настройкой Saby. Автоматическая отправка выключена.' };
  return { enabled: true };
}
