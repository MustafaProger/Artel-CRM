import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapLink, safeMapUrl } from '../web/src/map-link'

test('saved Yandex links retain their selected location and take precedence over other fields', () => {
  const mapUrl = 'https://yandex.ru/maps/-/example?ll=37.6%2C55.7'
  assert.deepEqual(mapLink({ mapUrl, latitude: 0, longitude: 0, address: 'Другой адрес' }), { href: mapUrl, label: 'Открыть в Яндекс.Картах' })
  assert.equal(safeMapUrl('http://maps.yandex.ru/?pt=37.6,55.7'), 'http://maps.yandex.ru/?pt=37.6,55.7')
  assert.equal(safeMapUrl('https://ya.ru/maps/-/example'), 'https://ya.ru/maps/-/example')
})

test('unsafe schemes, credentials, deceptive hosts and control characters cannot become map links', () => {
  for (const mapUrl of ['javascript:alert(1)', 'data:text/html,hello', '//yandex.ru/maps/', 'https://yandex.ru.evil.test/maps/', 'https://evil.test/?next=yandex.ru', 'https://yandex.ru@evil.test/maps/', 'https://user:password@yandex.ru/maps/', 'https://yandex.ru:8443/maps/', 'https://yan\ndex.ru/maps/']) {
    assert.equal(safeMapUrl(mapUrl), null, mapUrl)
    const fallback = mapLink({ mapUrl, address: 'Москва, улица Примерная, 1' })!
    assert.equal(new URL(fallback.href).hostname, 'yandex.ru')
    assert.equal(new URL(fallback.href).searchParams.get('text'), 'Москва, улица Примерная, 1')
  }
})

test('explicit coordinates use longitude-latitude order, including zero, without searching an address', () => {
  for (const [latitude, longitude] of [['55.75', '37.61'], [0, 0], [-90, -180]]) {
    const link = mapLink({ latitude, longitude, address: 'Адрес для поиска' })!
    const url = new URL(link.href)
    assert.equal(url.searchParams.get('pt'), `${longitude},${latitude}`)
    assert.equal(url.searchParams.get('text'), null)
    assert.equal(link.label, 'Открыть в Яндекс.Картах')
  }
})

test('missing, partial or invalid coordinates fall back to full address search, never an invented pin', () => {
  for (const point of [{}, { latitude: '', longitude: '' }, { latitude: 55, longitude: null }, { latitude: 91, longitude: 37 }, { latitude: 55, longitude: 181 }, { latitude: NaN, longitude: 37 }, { latitude: '0x10', longitude: '37' }]) {
    const link = mapLink({ ...point, address: '  Москва, улица Примерная, 1 & въезд № 2  ' })!
    const url = new URL(link.href)
    assert.equal(url.searchParams.get('text'), 'Москва, улица Примерная, 1 & въезд № 2')
    assert.deepEqual([...url.searchParams.keys()], ['text'])
    assert.equal(link.label, 'Найти адрес в Яндекс.Картах')
  }
})

test('no location data produces no link; unsafe saved URLs never bypass that check', () => {
  assert.equal(mapLink({}), null)
  assert.equal(mapLink({ address: '  ', latitude: null, longitude: null }), null)
  assert.equal(mapLink({ mapUrl: 'javascript:alert(1)' }), null)
})
