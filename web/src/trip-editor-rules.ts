import type { Directories } from './model'

/** The driver's explicit default is the only automatic vehicle choice. */
export function driverVehicleId(directories: Directories, driverId: string) {
  const vehicleId = directories.drivers.find(driver => driver.id === driverId)?.vehicleId
  return vehicleId && directories.vehicles.some(vehicle => vehicle.id === vehicleId) ? vehicleId : ''
}

/** An explicit edit synchronizes loading only. Nonempty or manually cleared unloading stays intact. */
export function loadingDateFields(value: string) {
  return { loading_at: value, date: value.slice(0, 10), loading_planned_at: value, loading_actual_at: value }
}

export function initialUnloadingFields(value: string) {
  return { unloading_planned_at: value, unloading_actual_at: value }
}
