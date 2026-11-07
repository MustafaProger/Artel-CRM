export const cabinetProviders = [
  { id: 'glopro', name: 'GloPro', url: 'https://lk.glopro.ru/', confirmation: false },
  { id: 'yandex', name: 'Яндекс Go', url: 'https://business.taxi.yandex.ru/', confirmation: true },
  { id: 'licard', name: 'ЛУКОЙЛ', url: 'https://lk.licard.com/', confirmation: true },
  { id: 'rosneft', name: 'Роснефть', url: 'https://lk.rn-card.ru/Account/Login?ReturnUrl=%2F', confirmation: false },
  // The supplied HTTP address must not be used for transmitting credentials.
  { id: 'natcar', name: 'natcar', url: 'https://lk.natcar.ru/', confirmation: false },
] as const;
export type CabinetProvider = typeof cabinetProviders[number]['id'];
export interface CabinetConnection {
  id: string;
  provider: CabinetProvider;
  label: string;
  createdAt: string;
  state: 'awaiting_setup' | 'connected' | 'error' | 'auth_required';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  error?: string;
  accounts?: CabinetAccount[];
  organizationNames?: string[];
}
export interface CabinetResponse { connections: CabinetConnection[]; credentialStorageReady: boolean }

export interface CabinetAccount {
  id: string;
  supplier: string;
  contract?: string;
  organization?: string;
  balanceLabel?: string;
  details?: { label: string; amountMinor: number }[];
  amountMinor: number;
  currency: 'RUB';
  sourceUpdatedAt?: string;
}
