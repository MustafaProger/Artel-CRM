import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupRequestsByLocation, requestVolumeBand } from '../web/src/trip-map-points'
import type { TripRequest } from '../web/src/trip-request-model'

test('map volume bands assign every boundary to the next band', () => {
  for (const [litres, band] of [
    ['0', 'blue'], ['1999.999999', 'blue'], ['2000', 'green'], ['5999.999999', 'green'],
    ['6000', 'yellow'], ['9499.999999', 'yellow'], ['9500', 'yellow'], ['10999.999999', 'yellow'], ['11000', 'red'], ['13999.999999', 'red'],
    ['14000', 'burgundy'], ['17000', 'burgundy'],
  ]) assert.equal(requestVolumeBand(litres).id, band, litres)
})

test('shared point color uses exact summed litres and retains each request without moving unlocated ones', () => {
  const request = (id: string, quantityLitres: string) => ({ id, quantityLitres }) as TripRequest
  const sources = [
    { request: request('a', '1999.999999'), coordinates: [55, 37] as [number, number] },
    { request: request('b', '0.000001'), coordinates: [55, 37] as [number, number] },
    { request: request('c', '6000'), coordinates: [56, 38] as [number, number] },
    { request: request('d', '8000'), coordinates: [56, 38] as [number, number] },
    { request: request('unlocated', '50000'), coordinates: null },
  ]
  const before = structuredClone(sources), groups = groupRequestsByLocation(sources)
  assert.equal(groups.size, 2)
  assert.equal(groups.get('55,37')?.totalLitres, '2000')
  assert.equal(requestVolumeBand(groups.get('55,37')!.totalLitres).id, 'green')
  assert.equal(groups.get('56,38')?.totalLitres, '14000')
  assert.equal(requestVolumeBand(groups.get('56,38')!.totalLitres).id, 'burgundy')
  assert.deepEqual(groups.get('56,38')?.requests.map(row => row.id), ['c', 'd'])
  assert.deepEqual(sources, before)
})

test('map grouping preserves six fractional digits for large API-valid quantities', () => {
  const locations = [
    { request: { id: 'large', quantityLitres: '123456789012345678901234567890.123456' } as TripRequest, coordinates: [55, 37] as [number, number] },
    { request: { id: 'small', quantityLitres: '0.000001' } as TripRequest, coordinates: [55, 37] as [number, number] },
  ]
  const group = groupRequestsByLocation(locations).get('55,37')!
  assert.equal(group.totalLitres, '123456789012345678901234567890.123457')
  assert.equal(requestVolumeBand(group.totalLitres).id, 'burgundy')
})
