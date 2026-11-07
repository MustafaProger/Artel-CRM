import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTripRequestsMapConfig } from '../server/trip-request-geocoding'
import { tripRequestExplicitCoordinates, tripRequestMapCoordinates } from '../web/src/trip-request-map-coordinates'

test('Yandex Tiles readiness never returns keys and ignores the former JS API key', () => {
  const empty = { provider: 'yandex', configured: false, rendering: 'tiles', projection: 'web_mercator' }
  assert.deepEqual(readTripRequestsMapConfig({}), empty)
  assert.deepEqual(readTripRequestsMapConfig({ YANDEX_TILES_API_KEY: ' ', PRIVATE_SECRET: 'never-return' }), empty)
  assert.deepEqual(readTripRequestsMapConfig({ ARTEL_YANDEX_MAPS_API_KEY: 'former-browser-key-123456' }), empty)
  const configured = readTripRequestsMapConfig({ YANDEX_TILES_API_KEY: 'test-server-key-123456', PRIVATE_SECRET: 'never-return' })
  assert.deepEqual(configured, { ...empty, configured: true })
  assert.doesNotMatch(JSON.stringify(configured), /key|secret|test-server|never-return/i)
})

test('directory coordinates have precedence including zero; empty/partial/out-of-range coordinates are rejected', () => {
  assert.deepEqual(tripRequestExplicitCoordinates({ latitude: '0', longitude: '0' }), { status: 'found', latitude: 0, longitude: 0, source: 'directory' })
  assert.deepEqual(tripRequestExplicitCoordinates({ latitude: '55.7', longitude: '37.6', mapUrl: 'https://yandex.ru/maps/?pt=45,54' }), { status: 'found', latitude: 55.7, longitude: 37.6, source: 'directory' })
  for (const input of [{ latitude: '', longitude: '' }, { latitude: '55', longitude: null }, { latitude: '91', longitude: '1' }, { latitude: '1', longitude: '181' }, { latitude: '0x10', longitude: '20' }, { latitude: NaN, longitude: 20 }]) assert.equal(tripRequestExplicitCoordinates(input), null)
})

test('only explicit Yandex pin coordinates are locations, never a viewport, search string or ambiguous pins', () => {
  assert.deepEqual(tripRequestExplicitCoordinates({ mapUrl: 'https://yandex.ru/maps/?pt=37.6,55.7,pm2rdm' }), { status: 'found', latitude: 55.7, longitude: 37.6, source: 'map_url' })
  for (const mapUrl of ['https://yandex.ru/maps/?ll=37.6,55.7', 'https://yandex.ru/maps/?text=55.7,37.6', 'https://yandex.ru/maps/?pt=37.6,55.7~45,54', 'https://yandex.ru.evil.test/maps/?pt=37.6,55.7', 'https://user:password@yandex.ru/maps/?pt=37.6,55.7', 'http://yandex.ru/maps/?pt=37.6,55.7', 'https://yandex.ru/maps/?pt=37.6,91']) assert.equal(tripRequestExplicitCoordinates({ mapUrl }), null)
})

test('request projection uses its own saved point and never follows later directory corrections', () => {
  const request = { companyId: 'company', addressId: 'site', address: 'Синтетическая улица, 1', latitude: null, longitude: null }
  const address = { id: 'site', companyId: 'company', kind: 'delivery', name: 'База', address: request.address, latitude: '55.7', longitude: '37.6' }
  assert.equal(tripRequestMapCoordinates(request, [address]), null)
  const automatic = { status: 'found' as const, latitude: 51, longitude: 42, source: 'geocoder' as const, accuracy: 'building' as const }
  assert.deepEqual(tripRequestMapCoordinates({ ...request, location: automatic }, [address]), automatic)
  assert.deepEqual(request, { companyId: 'company', addressId: 'site', address: 'Синтетическая улица, 1', latitude: null, longitude: null })
  for (const changed of [{ id: 'other' }, { companyId: 'other' }, { kind: 'loading' }, { address: 'Другой адрес' }, { latitude: undefined, longitude: undefined, mapUrl: 'https://yandex.ru/maps/?ll=37.6,55.7' }]) assert.equal(tripRequestMapCoordinates(request, [{ ...address, ...changed }]), null)
  assert.deepEqual(tripRequestMapCoordinates({ ...request, latitude: '50', longitude: '40' }, [address]), { status: 'found', latitude: 50, longitude: 40, source: 'directory' })
  assert.deepEqual(tripRequestMapCoordinates({ ...request, mapUrl: 'https://yandex.ru/maps/?pt=41,51' }, [address]), { status: 'found', latitude: 51, longitude: 41, source: 'map_url' })
  assert.equal(tripRequestMapCoordinates({ ...request, latitude: '50' }, [address]), null)
})
