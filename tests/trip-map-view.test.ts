import assert from 'node:assert/strict'
import test from 'node:test'
import { mapCardPosition, moscowOverviewBounds, requestFitView, requestOverviewBounds } from '../web/src/trip-map-view.ts'

test('an empty map, one Moscow pin and four local pins retain the same broad overview', () => {
  for (const points of [[], [[55.6, 37.4]], [[55.5, 37.3], [55.7, 37.8], [55.8, 38.1], [55.9, 37.4]]] as [number, number][][]) {
    assert.deepEqual(requestOverviewBounds(points), moscowOverviewBounds)
  }
})
test('outlying requests extend the overview, retaining Moscow and every direction', () => {
  assert.deepEqual(requestOverviewBounds([[59.9, 30.3], [52, 42]]), [[52, 30.3], [59.9, 42]])
  assert.deepEqual(moscowOverviewBounds, [[54.85, 36.35], [56.5, 39]])
})
test('explicit Show all fits local request coordinates without the initial Moscow extent', () => {
  assert.deepEqual(requestFitView([[55.6032093, 37.3583189], [55.643825, 37.851260]]), {
    bounds: [[55.6032093, 37.3583189], [55.643825, 37.851260]], maxZoom: 12,
  })
})
test('single and colocated requests center the same point with a limited zoom', () => {
  for (const points of [[[55.6, 37.4]], [[55.6, 37.4], [55.6, 37.4], [55.6, 37.4]]] as [number, number][][]) {
    assert.deepEqual(requestFitView(points), { center: [55.6, 37.4], zoom: 12 })
  }
})
test('explicit Show all includes every direction and handles points sharing a latitude or longitude', () => {
  assert.deepEqual(requestFitView([[59.9, 30.3], [52, 42], [55.6, 37.4]]), {
    bounds: [[52, 30.3], [59.9, 42]], maxZoom: 12,
  })
  assert.deepEqual(requestFitView([[55.6, 37.4], [55.6, 38.1]]), {
    bounds: [[55.6, 37.4], [55.6, 38.1]], maxZoom: 12,
  })
  assert.deepEqual(requestFitView([[55.6, 37.4], [56.1, 37.4]]), {
    bounds: [[55.6, 37.4], [56.1, 37.4]], maxZoom: 12,
  })
})
test('explicit Show all has no target for empty or invalid locations and ignores invalid outliers', () => {
  const invalid: [number, number][] = [[NaN, 37], [55, Infinity], [91, 37], [55, -181]]
  assert.equal(requestFitView([]), null)
  assert.equal(requestFitView(invalid), null)
  assert.deepEqual(requestFitView([...invalid, [55.6, 37.4]]), { center: [55.6, 37.4], zoom: 12 })
})
test('edge cards keep a readable width and stay inside the map without moving it', () => {
  for (const anchor of [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 0, y: 500 }]) {
    const position = mapCardPosition(anchor, { width: 340, height: 220 }, { width: 600, height: 500 })
    assert.ok(position.left >= 12 && position.left + 340 <= 588)
    assert.ok(position.top >= 12 && position.top + 220 <= 488)
  }
})
