export interface ChinaFuel { supplierId: string; litres: string; amount: string }
export interface ChinaDay { id: string; date: string; version: number; fuels: ChinaFuel[]; createdBy: string; createdAt: string; updatedAt: string }
export interface ChinaPayment { id: string; date: string; amount: string; createdBy: string; createdAt: string }
export interface ChinaData { days: ChinaDay[]; payments: ChinaPayment[] }
export const emptyChina = (): ChinaData => ({ days: [], payments: [] });
