import assert from 'node:assert/strict'
import test from 'node:test'
import { operatorPlanFields } from '../server/operator-plans'
import { operatorRequisitesDraft, operatorRequisitesError, operatorRequisitesInputText, operatorRequisitesPayload, operatorRequisitesText } from '../web/src/operator-requisites'

test('unified requisites preserve both historical fields and hidden details during unrelated edits', () => {
  const saved = { id: 'recipient', name: 'Получатель', bank: 'Банк', card: '0012 3456\nсчёт 001', phone: '+7 (900) 123-45-67', details: 'Сохранённые сведения', limit: '100.00' }
  const draft = operatorRequisitesDraft(saved)
  assert.equal(draft.requisites, '0012 3456 счёт 001 · +7 (900) 123-45-67')
  assert.deepEqual(operatorRequisitesPayload({ ...draft, limit: '200.00' }), { ...saved, limit: '200.00' })
  assert.equal(operatorRequisitesPayload({ ...draft, requisites: `${draft.requisites}x`, name: 'Другой' }).details, saved.details)
  assert.deepEqual(operatorRequisitesPayload({ ...draft, requisites: operatorRequisitesInputText(saved) }), saved)
  assert.equal(operatorRequisitesText(saved), '0012 3456\nсчёт 001 · +7 (900) 123-45-67')
  assert.equal(saved.card, '0012 3456\nсчёт 001')
})

test('single-line drafts preserve CRLF historical bytes after native input sanitization and editing another field', () => {
  const saved = { card: 'Счёт 0001\r\n0002', phone: '+7\n900', details: 'Архив', limit: '100.00' }
  const draft = operatorRequisitesDraft(saved)
  assert.equal(draft.requisites, 'Счёт 0001 0002 · +7 900')
  const nativeInputValue = draft.requisites.replace(/[\r\n]/g, '')
  assert.deepEqual(operatorRequisitesPayload({ ...draft, requisites: nativeInputValue, limit: '200.00' }), { ...saved, limit: '200.00' })
  assert.equal(operatorRequisitesError(saved, nativeInputValue), '')
})

test('new and edited requisites keep entered text without inferring or splitting number types', () => {
  const empty = operatorRequisitesDraft({ card: '', phone: '', details: 'Архив' })
  for (const text of ['+7 (900) 000-00-00', '00001234567890123456', 'Карта 0001 · телефон +7 900\nКомментарий']) {
    assert.deepEqual(operatorRequisitesPayload({ ...empty, requisites: text }), { card: text, phone: '', details: 'Архив' })
  }
  const old = operatorRequisitesDraft({ card: '1111', phone: '+7 900', details: 'Архив' })
  assert.deepEqual(operatorRequisitesPayload({ ...old, requisites: '2222' }), { card: '2222', phone: '', details: 'Архив' })
  assert.deepEqual(operatorRequisitesPayload({ ...old, requisites: '' }), { card: '', phone: '', details: 'Архив' })
})

test('single legacy values are displayed once and preserve their original field', () => {
  for (const saved of [{ card: '0001', phone: '' }, { card: '', phone: '+7 900' }, { card: '', phone: '' }]) {
    const draft = operatorRequisitesDraft(saved)
    assert.equal(draft.requisites, saved.card || saved.phone)
    assert.deepEqual(operatorRequisitesPayload(draft), saved)
  }
})

test('two full legacy fields remain valid and untruncated while edited values respect the existing limit', () => {
  const saved = { card: '1'.repeat(500), phone: '2'.repeat(500), limit: '100.00' }
  const draft = operatorRequisitesDraft(saved)
  assert.equal(draft.requisites.length, 1003)
  assert.equal(operatorRequisitesError(draft, draft.requisites), '')
  assert.deepEqual(operatorRequisitesPayload({ ...draft, limit: '200.00' }), { ...saved, limit: '200.00' })
  assert.notEqual(operatorRequisitesError(draft, `${draft.requisites.slice(0, -1)}3`), '')
  assert.notEqual(operatorRequisitesError(draft, '3'.repeat(501)), '')
  assert.equal(operatorRequisitesError(draft, '3'.repeat(500)), '')
  assert.equal(operatorRequisitesError(draft, operatorRequisitesText(saved)), '')
  assert.notEqual(operatorRequisitesError({ card: '', phone: '' }, '3'.repeat(501)), '')
})

test('an unchanged long legacy combination remains accepted by the existing server plan schema', () => {
  const saved = { id: 'e37aebc8-c519-4ce2-9348-094f2f10f54a', name: 'Получатель', bank: 'Банк', card: '1'.repeat(500), phone: '2'.repeat(500), details: 'Скрытые сведения', limit: '100.00' }
  const draft = operatorRequisitesDraft(saved)
  const unchanged = operatorPlanFields({ clientName: 'Клиент', recipients: [operatorRequisitesPayload({ ...draft, limit: '200.00' })] })
  assert.deepEqual(unchanged.recipients[0], { ...saved, limit: '200.00' })
  const edited = operatorPlanFields({ clientName: 'Клиент', recipients: [operatorRequisitesPayload({ ...draft, requisites: '+7 900 123-45-67' })] })
  assert.deepEqual(edited.recipients[0], { ...saved, card: '+7 900 123-45-67', phone: '' })
})
