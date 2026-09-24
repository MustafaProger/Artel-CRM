/** Server-owned identities: request input never selects an account or credential prefix. */
export const sberConnections = {
  'sber-nk-artel': { id: 'sber-nk-artel', account: '40702810438720035571', company: 'ООО «НК АРТЭЛЬ»', inn: '5050140563', prefix: 'ARTEL_BANK_SBER_NK', slot: 'sber' },
  'sber-artel': { id: 'sber-artel', account: '40702810538000003495', company: 'ООО «АРТЭЛЬ»', inn: '9721079780', prefix: 'ARTEL_BANK_SBER_ARTEL', slot: 'sberArtel' },
} as const;
export type SberConnectionId = keyof typeof sberConnections;
export type SberConnection = typeof sberConnections[SberConnectionId];
export const defaultSberConnection = sberConnections['sber-nk-artel'];
