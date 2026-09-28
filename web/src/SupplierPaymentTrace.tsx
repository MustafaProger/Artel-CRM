import { useEffect, useState } from 'react'
import type { BankOperation } from './banking-model'
import type { SettlementsReport } from './settlements-model'
import { overviewMoney as money } from './overview-model'

/** Read the same projection as Overview; never import, book or send a payment. */
export default function SupplierPaymentTrace({ operation }: { operation: BankOperation }) {
  const [report, setReport] = useState<SettlementsReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setReport(null); setError('')
    if (operation.direction !== 'outgoing') return
    const controller = new AbortController()
    setLoading(true)
    void fetch('/api/settlements', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? 'Для просмотра расчётов нужен доступ к Обзору.' : 'Не удалось загрузить распределение платежа.')
      return await response.json() as SettlementsReport
    }).then(value => { if (!controller.signal.aborted) setReport(value) }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить распределение платежа.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [operation.id, operation.updatedAt, operation.direction])
  if (operation.direction !== 'outgoing') return null
  const match = report?.organizations?.flatMap(organization => organization.suppliers.companies.flatMap(company => company.receipts
    .filter(receipt => receipt.id === operation.id || receipt.bankOperationId === operation.bankOperationId && receipt.account === operation.account && receipt.connectionId === operation.connectionId)
    .map(receipt => ({ organization, company, receipt })))).at(0)
  const review = report?.organizations?.flatMap(organization => organization.suppliers.review).find(row => row.id === operation.id)
  return <section className="bank-supplier-trace" aria-label="Распределение оплаты поставщику">
    <h3>Оплата поставщику</h3>
    {loading ? <p role="status">Загружаем распределение…</p> : error ? <p role="status">{error}</p> : match ? <>
      <p><strong>{match.company.name}</strong> · {match.organization.name}</p>
      <dl className="bank-details-grid"><div><dt>Исходная сумма платежа</dt><dd>{money(match.receipt.amount)}</dd></div><div><dt>Погашено закупок</dt><dd>{money(match.receipt.allocated)}</dd></div><div><dt>Остаток аванса этого платежа</dt><dd>{money(match.receipt.advance)}</dd></div></dl>
      {match.receipt.allocations.length > 0 ? <div className="bank-table-scroll" role="region" tabIndex={0} aria-label="Закупки, оплаченные платежом"><table className="bank-table"><thead><tr><th>Закупка / отгрузка</th><th>Из этого платежа</th><th>Остаток долга закупки</th></tr></thead><tbody>{match.receipt.allocations.map(allocation => {
        const shipment = match.company.shipments.find(row => row.id === allocation.shipmentId)
        return <tr key={allocation.shipmentId}><td>{shipment?.number ? `№ ${shipment.number}` : allocation.shipmentId}<small>{shipment?.date ?? 'Дата не указана'}</small></td><td>{money(allocation.amount)}</td><td>{money(shipment?.debt ?? null)}</td></tr>
      })}</tbody></table></div> : <p>Платёж сохранён как аванс поставщику в этой организации.</p>}
      <p className="bank-footnote">Оплата распределяется по самым ранним закупкам. Закрытые закупки остаются в истории. Остатки показаны на момент расчёта.</p>
    </> : <p>{review?.reason ?? 'Операция не включена в расчёты поставщиков. Учитываются подтверждённые рублёвые списания поставщику с установленным ИНН и нашей организацией.'}</p>}
  </section>
}
