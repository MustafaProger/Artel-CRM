import { allVehicleFields } from '../web/src/directory-fields';
import Decimal from 'decimal.js';
import type { Directories, Driver, Vehicle } from '../web/src/model';

const vehicles: Vehicle[] = [
  { id: 'fleet-vehicle-hyundai-489', name: 'Hyundai 489', plate: 'Hyundai 489', brand: 'Hyundai', capacityLitres: '10228', compartmentsLitres: ['5700', '4528'] },
  { id: 'fleet-vehicle-maz-063', name: 'МАЗ 063', plate: 'МАЗ 063', brand: 'МАЗ', capacityLitres: '16813', compartmentsLitres: ['8500', '8313'] },
  { id: 'fleet-vehicle-maz-700', name: 'МАЗ 700', plate: 'МАЗ 700', brand: 'МАЗ', capacityLitres: '15048', compartmentsLitres: ['4954', '4976', '5118'] },
  { id: 'fleet-vehicle-hyundai-442', name: 'Hyundai 442', plate: 'Hyundai 442', brand: 'Hyundai', capacityLitres: '17500', compartmentsLitres: ['8000', '5500', '4000'] },
  { id: 'fleet-vehicle-gazel-rpz', name: 'Газель РПЗ', plate: 'Газель РПЗ', brand: 'Газель' },
];
const drivers: Driver[] = [
  { id: 'fleet-driver-vova', name: 'Вова', phone: '+7 (925) 607-09-59', vehicleId: 'fleet-vehicle-hyundai-489' },
  { id: 'fleet-driver-stas', name: 'Стас', phone: '+7 (966) 025-39-19', vehicleId: 'fleet-vehicle-maz-063' },
  { id: 'fleet-driver-gena', name: 'Гена', phone: '+7 (967) 137-68-28', vehicleId: 'fleet-vehicle-maz-700' },
  { id: 'fleet-driver-sasha', name: 'Саша', phone: '+7 (915) 688-21-69', vehicleId: 'fleet-vehicle-maz-700' },
  { id: 'fleet-driver-petr', name: 'Петр', phone: '+7 (960) 330-27-66', vehicleId: 'fleet-vehicle-hyundai-442' },
  { id: 'fleet-driver-oleg', name: 'Олег', phone: '+7 (977) 151-21-39', vehicleId: 'fleet-vehicle-hyundai-442' },
  { id: 'fleet-driver-denis', name: 'Денис', phone: '+7 (977) 554-94-03', vehicleId: 'fleet-vehicle-gazel-rpz' },
];
const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const vehicleKey = (value: string) => value.normalize('NFKC').toUpperCase().replace(/[^\p{L}\d]/gu, '').replace(/[ABCEHKMOPTXY]/g, c => ({ A:'А',B:'В',C:'С',E:'Е',H:'Н',K:'К',M:'М',O:'О',P:'Р',T:'Т',X:'Х',Y:'У' }[c]!));
const unusedId = (desired: string, rows: { id: string }[]) => {
  let id = desired;
  for (let suffix = 2; rows.some(row => row.id === id); suffix++) id = `${desired}-${suffix}`;
  return id;
};

/** Add the supplied fleet to both old and new stores, keeping existing records verbatim. */
export function withFleetDirectories(saved: Directories): Directories {
  if (saved.fleetSeedApplied) return saved;
  const result = { ...saved, vehicles: [...saved.vehicles], drivers: [...saved.drivers] };
  const vehicleIds = new Map<string, string>();
  for (const seed of vehicles) {
    if (saved.deletedEntries?.vehicles?.includes(seed.id)) continue;
    const key = vehicleKey(seed.name!);
    const existing = result.vehicles.find(row => row.id === seed.id) ?? result.vehicles.find(row => [row.name, row.plate, [row.brand, row.model, row.plate].filter(Boolean).join(' ')].some(label => label && vehicleKey(label) === key));
    if (existing) vehicleIds.set(seed.id, existing.id);
    else {
      const vehicle = { ...seed, id: unusedId(seed.id, result.vehicles), ...(seed.compartmentsLitres ? { compartmentsLitres: [...seed.compartmentsLitres] } : {}) };
      result.vehicles.push(vehicle);
      vehicleIds.set(seed.id, vehicle.id);
    }
  }
  for (const seed of drivers) {
    if (saved.deletedEntries?.drivers?.includes(seed.id) || !vehicleIds.has(seed.vehicleId)) continue;
    if (result.drivers.some(row => row.id === seed.id || nameKey(row.name) === nameKey(seed.name))) continue;
    result.drivers.push({ ...seed, id: unusedId(seed.id, result.drivers), vehicleId: vehicleIds.get(seed.vehicleId)! });
  }
  return { ...result, fleetSeedApplied: true };
}

export const validLitres = (value: unknown): value is string => typeof value === 'string' && /^\d{1,9}(?:\.\d{1,6})?$/.test(value) && new Decimal(value).gt(0);
export const validPhone = (value: unknown): value is string => typeof value === 'string' && /^[+\d\s()-]+$/.test(value) && /^\d{7,15}$/.test(value.replace(/\D/g, ''));
export function validVehicleMetadata(row: Record<string, unknown>): boolean {
  for (const key of ['name', 'brand', 'model', 'trailer', ...allVehicleFields.map(([key])=>key)]) if (row[key] !== undefined && (typeof row[key] !== 'string' || (row[key] as string).length > 500)) return false;
  if (row.capacityLitres !== undefined && !validLitres(row.capacityLitres)) return false;
  if (row.compartmentsLitres !== undefined) {
    if (!Array.isArray(row.compartmentsLitres) || !row.compartmentsLitres.length || row.compartmentsLitres.length > 20 || !row.compartmentsLitres.every(validLitres)) return false;
    if (row.capacityLitres !== undefined && !row.compartmentsLitres.reduce((total: Decimal, amount: string) => total.plus(amount), new Decimal(0)).eq(row.capacityLitres as string)) return false;
  }
  return true;
}
