import type { OperatorRecipientFields } from './operator-model'

type RequisitesFields = Pick<OperatorRecipientFields, 'card' | 'phone'>
export type OperatorRequisitesDraft<T extends RequisitesFields> = T & { requisites: string }

/** Display both historical values without inferring whether text is a card, account or phone. */
export function operatorRequisitesText(recipient: RequisitesFields): string {
  return [recipient.card, recipient.phone].filter(Boolean).join(' · ')
}

/** Native text inputs remove line breaks; flatten only the draft, never the saved historical fields. */
export function operatorRequisitesInputText(recipient: RequisitesFields): string {
  return operatorRequisitesText(recipient).replace(/[\r\n]+/g, ' ')
}

export function operatorRequisitesDraft<T extends RequisitesFields>(recipient: T): OperatorRequisitesDraft<T> {
  return { ...recipient, requisites: operatorRequisitesInputText(recipient) }
}

/** Unchanged drafts retain both original fields, including after editing and undoing the text. */
export function operatorRequisitesPayload<T extends RequisitesFields>(draft: OperatorRequisitesDraft<T>) {
  const { requisites, ...recipient } = draft
  if (requisites === operatorRequisitesInputText(draft)) return recipient
  return { ...recipient, card: requisites, phone: '' }
}

/** A long legacy combination is valid unchanged; edited text follows the existing field limit. */
export function operatorRequisitesError(recipient: RequisitesFields, value: string): string {
  if (value !== operatorRequisitesInputText(recipient) && value.length > 500) return 'Укажите не более 500 символов в поле «Карта / счёт / телефон».'
  return ''
}
