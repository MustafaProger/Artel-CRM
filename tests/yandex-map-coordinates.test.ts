import assert from 'node:assert/strict'
import test from 'node:test'
import { createXYZ } from 'ol/tilegrid.js'
import { projectMapBounds, projectMapPoint, unprojectMapPoint, yandexTileUrl } from '../web/src/yandex-map-coordinates.ts'

test('real delivery points round-trip in spherical Web Mercator without reversing axes', () => {
  for (const point of [[55.6032093, 37.3583189], [55.643825, 37.851260]] as [number, number][]) {
    const projected = projectMapPoint(point), result = unprojectMapPoint(projected)
    assert.ok(Math.abs(result[0] - point[0]) < 1e-10)
    assert.ok(Math.abs(result[1] - point[1]) < 1e-10)
    assert.ok(projected[0] > 4_000_000 && projected[0] < 4_300_000)
    assert.ok(projected[1] > 7_400_000 && projected[1] < 7_600_000)
    const [z, x, y] = createXYZ().getTileCoordForCoordAndZ(projected, 10)
    // Yandex web_mercator uses standard XYZ numbering from north-west, not TMS.
    assert.equal(z, 10); assert.equal(x, point[1] < 37.5 ? 618 : 619); assert.equal(y, 320)
    assert.equal(yandexTileUrl(z, x, y, 2), `/api/maps/yandex/tiles?x=${x}&y=320&z=10&scale=2`)
  }
})
test('bounds retain increasing projected coordinates and pole inputs stay finite', () => {
  const [left, bottom, right, top] = projectMapBounds([[55.6032093, 37.3583189], [55.643825, 37.851260]])
  assert.ok(left < right && bottom < top)
  for (const latitude of [-90, 90]) assert.ok(projectMapPoint([latitude, 180]).every(Number.isFinite))
})
