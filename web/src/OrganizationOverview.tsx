import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowDownLeft, ArrowLeft, Building2, ChevronRight, Search, Truck, Wallet, X } from 'lucide-react'
import type { OrganizationSettlement } from './organization-settlements-model'
import type { SettlementCompany, SettlementReceipt, SettlementShipment, SettlementsReport } from './settlements-model'
import { OverviewDecimal as Exact, companyBalance, hasUnknownAmounts, needsReview, overviewMoney as money, signedMoney } from './overview-model'
import { sortOverviewCompanies, sortOverviewEntries, type OverviewEntry, type OverviewSort } from './overview-sorting'

type Side = 'suppliers' | 'clients'
type Filter = 'all' | 'debt' | 'advance' | 'review'
const positive = (value: string) => new Exact(value).gt(0)
const date = (value: string | null) => {
  if (!value) return 'Дата не указана'
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  return Number.isNaN(parsed.getTime()) ? 'Дата не указана' : parsed.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' })
}
const shipmentTitle = (shipment: SettlementShipment, side: Side) => `${side === 'suppliers' ? 'Закупка' : 'Отгрузка'} ${shipment.number ? `№ ${shipment.number}` : 'без номера'}`
const paymentTitle = (receipt: SettlementReceipt, side: Side) => `${side === 'suppliers' ? 'Оплата поставщику' : 'Поступление клиента'}${receipt.documentNumber ? ` № ${receipt.documentNumber}` : ''}`
const stateLabel = (company: SettlementCompany, side: Side, supplierScope = false) => {
  if (hasUnknownAmounts(company)) return 'Известные суммы · нужна проверка'
  if (!company.shipments.length && !company.receipts.length) return 'Операций пока нет'
  const balance = new Exact(companyBalance(company))
  if (supplierScope) return balance.lt(0) ? 'Долг по вашим закупкам' : 'Ваши закупки оплачены'
  return balance.lt(0) ? side === 'suppliers' ? 'Наш долг поставщику' : 'Долг клиента' : balance.gt(0) ? side === 'suppliers' ? 'Наш аванс поставщику' : 'Аванс клиента' : 'Расчёты закрыты'
}

export default function OrganizationOverview({ organizations, unassignedShipmentCount }: { organizations: OrganizationSettlement[]; unassignedShipmentCount: number }) {
  const [organizationId, setOrganizationId] = useState('nk-artel')
  const [side, setSide] = useState<Side>('suppliers')
  const organization = organizations.find(row => row.id === organizationId) ?? organizations[0]
  return <section className="organization-overview" aria-label="Расчёты по нашим организациям">
    {organization ? <>
      <div className="overview-organization-picker" role="group" aria-label="Наша организация">{organizations.map(row => <button type="button" key={row.id} aria-pressed={organization.id === row.id} onClick={() => setOrganizationId(row.id)} data-organization-id={row.id}><Building2 size={20}/><span>{row.name}</span></button>)}</div>
      <div className="overview-ledger-tabs" role="group" aria-label="Сторона взаиморасчётов"><button type="button" aria-pressed={side === 'suppliers'} onClick={() => setSide('suppliers')}>Поставщики</button><button type="button" aria-pressed={side === 'clients'} onClick={() => setSide('clients')}>Клиенты</button></div>
      {unassignedShipmentCount > 0 && <div className="overview-notice" data-testid="organization-unassigned-notice"><AlertCircle size={18}/><div><strong>Без нашей организации: {unassignedShipmentCount} отгрузок</strong></div></div>}
      <OrganizationLedger key={`${organization.id}:${side}`} report={organization[side]} organization={organization.name} organizationId={organization.id} side={side}/>
    </> : <div className="overview-empty overview-card"><Building2 size={30}/><h3>Раздельные расчёты пока недоступны</h3></div>}
  </section>
}

function OrganizationLedger({ report, organization, organizationId, side }: { report: SettlementsReport; organization: string; organizationId: string; side: Side }) {
  const supplierScope = side === 'suppliers' && report.scope === 'own'
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<OverviewSort>('amount-desc')
  const [selected, setSelected] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const term = query.trim().toLocaleLowerCase('ru-RU')
  const companies = useMemo(() => sortOverviewCompanies(report.companies.filter(company =>
    (!term || `${company.name} ${company.inn ?? ''}`.toLocaleLowerCase('ru-RU').includes(term)) &&
    (filter === 'all' || filter === 'debt' && positive(company.debt) || filter === 'advance' && positive(company.advance) || filter === 'review' && needsReview(company)),
  ), sort), [report.companies, term, filter, sort])
  const detail = report.companies.find(row => row.key === selected)
  useEffect(() => { if (selected) heading.current?.focus() }, [selected])
  const onBack = () => {
    const previous = selected
    setSelected(null)
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLButtonElement>('.organization-company-button')].find(button => button.dataset.companyKey === previous)?.focus({ preventScroll: true }))
  }
  return <section className="organization-ledger" data-testid="organization-ledger" data-organization-id={organizationId} data-side={side} aria-label={`${side === 'suppliers' ? 'Поставщики' : 'Клиенты'} · ${organization}`}>
    {selected ? detail ? <LedgerDetails company={detail} organization={organization} side={side} supplierScope={supplierScope} headingRef={heading} onBack={onBack}/> : <div className="overview-empty overview-card"><h3>Контрагент больше не доступен</h3><button type="button" className="button" onClick={onBack}>Назад к списку</button></div> : <>
      <dl className="overview-org-totals overview-card" aria-label={`Итоги · ${organization}`}><div><dt>{supplierScope ? 'Долг по вашим закупкам' : side === 'suppliers' ? 'Наш долг поставщикам' : 'Долг клиентов'}</dt><dd data-tone="debt" data-total="debt">{signedMoney(new Exact(report.totals.debt).negated().toFixed(2))}</dd></div><div><dt>{side === 'suppliers' ? 'Наш аванс поставщикам' : 'Авансы клиентов'}</dt><dd data-tone={supplierScope ? 'zero' : 'advance'} data-total="advance" className={supplierScope ? 'overview-scoped-value' : ''}>{supplierScope ? 'Доступен руководителю' : signedMoney(report.totals.advance)}</dd></div></dl>
      {report.companies.some(hasUnknownAmounts) && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Итог по известным суммам</strong></div></div>}
      <section className="overview-card overview-companies" aria-labelledby="organization-companies-title">
        <div className="overview-card-heading"><div><h3 id="organization-companies-title">{side === 'suppliers' ? 'Поставщики' : 'Клиенты'} · {organization} <span>{companies.length}</span></h3></div></div>
        <div className="overview-toolbar"><label className="overview-search"><Search size={18}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название или ИНН" aria-label="Поиск контрагентов по названию или ИНН"/>{query && <button type="button" aria-label="Очистить поиск контрагентов" onClick={() => setQuery('')}><X size={16}/></button>}</label><select aria-label="Фильтр контрагентов" value={filter} onChange={event => setFilter(event.target.value as Filter)}><option value="all">Все контрагенты</option><option value="debt">С долгом</option><option value="advance">С авансом</option><option value="review">Требуют проверки</option></select><LedgerSort value={sort} onChange={setSort} companies/></div>
        <div className="overview-list-caption" aria-hidden="true"><span>Контрагент</span><span>Баланс</span></div>
        {companies.length ? <ul className="overview-company-list">{companies.map(company => <li key={company.key}><button type="button" className="overview-company-button organization-company-button" data-company-key={company.key} data-testid="organization-company" onClick={() => setSelected(company.key)}><span className="overview-company-avatar" aria-hidden="true"><Building2 size={19}/></span><span className="overview-company-identity"><strong>{company.name}</strong><small>{company.inn ? `ИНН ${company.inn}` : 'ИНН не указан'} · {company.shipments.length} {side === 'suppliers' ? 'закупок' : 'отгрузок'}</small>{needsReview(company) && <span className="overview-issue-badge">Требует проверки</span>}</span><span className="overview-company-amount"><LedgerBalance company={company}/><small>{stateLabel(company, side, supplierScope)}</small></span><ChevronRight size={18} aria-hidden="true"/></button></li>)}</ul> : <div className="overview-empty"><Building2 size={30}/><h3>{query || filter !== 'all' ? 'Контрагенты не найдены' : 'Операций пока нет'}</h3>{(query || filter !== 'all') && <button type="button" className="button" onClick={() => { setQuery(''); setFilter('all') }}>Сбросить фильтры</button>}</div>}
      </section>
      <LedgerSources report={report}/>
    </>}
  </section>
}

function LedgerSort({ value, onChange, companies = false }: { value: OverviewSort; onChange: (value: OverviewSort) => void; companies?: boolean }) {
  return <select aria-label={companies ? 'Сортировка контрагентов' : 'Сортировка операций'} value={value} onChange={event => onChange(event.target.value as OverviewSort)}>
    <option value="amount-desc">Сначала большие суммы</option>
    <option value="amount-asc">Сначала меньшие суммы</option>
    {companies ? <optgroup label="По последней операции">
      <option value="date-desc">Сначала новые операции</option>
      <option value="date-asc">Сначала старые операции</option>
    </optgroup> : <>
      <option value="date-desc">Сначала новые</option>
      <option value="date-asc">Сначала старые</option>
    </>}
  </select>
}

function LedgerBalance({ company }: { company: SettlementCompany }) {
  const balance = companyBalance(company), value = new Exact(balance)
  return <strong className="overview-balance" data-testid="organization-company-balance" data-balance={balance} data-tone={value.lt(0) ? 'debt' : value.gt(0) ? 'advance' : 'zero'}>{signedMoney(balance)}</strong>
}
function LedgerDetails({ company, organization, side, supplierScope, headingRef, onBack }: { company: SettlementCompany; organization: string; side: Side; supplierScope: boolean; headingRef: React.RefObject<HTMLHeadingElement | null>; onBack: () => void }) {
  const [filter, setFilter] = useState<'all' | 'receipt' | 'shipment'>('all')
  const [sort, setSort] = useState<OverviewSort>('date-desc')
  const container = useRef<HTMLElement | null>(null)
  const transactions = useMemo(() => {
    const entries: OverviewEntry[] = [...company.shipments.map(item => ({ type: 'shipment' as const, date: item.date, item })), ...company.receipts.map(item => ({ type: 'receipt' as const, date: item.date, item }))]
    return sortOverviewEntries(entries, sort)
  }, [company, sort])
  const visible = transactions.filter(entry => filter === 'all' || filter === entry.type)
  const focusTransaction = (id: string, type: 'receipt' | 'shipment') => {
    setFilter('all')
    requestAnimationFrame(() => {
      const row = [...(container.current?.querySelectorAll<HTMLElement>('.overview-transaction') ?? [])].find(element => element.dataset.transactionId === id && element.dataset.type === type)
      const details = row?.querySelector('details')
      if (details) details.open = true
      row?.scrollIntoView({ block: 'center', behavior: 'instant' })
      row?.querySelector('summary')?.focus({ preventScroll: true })
    })
  }
  return <section ref={container} className="overview-company-details organization-company-details" data-company-key={company.key} aria-label={`Операции ${company.name} · ${organization}`}>
    <button type="button" className="overview-back" onClick={onBack}><ArrowLeft size={17}/>Назад к {side === 'suppliers' ? 'поставщикам' : 'клиентам'}</button>
    <div className="overview-card overview-company-hero"><div><span className="overview-eyebrow">{organization} · {side === 'suppliers' ? 'ПОСТАВЩИК' : 'КЛИЕНТ'}</span><h3 ref={headingRef} tabIndex={-1}>{company.name}</h3><p>{company.inn ? `ИНН ${company.inn}` : 'ИНН не указан'}</p></div><div className="overview-hero-balance"><LedgerBalance company={company}/><span>{stateLabel(company, side, supplierScope)}</span></div></div>
    {hasUnknownAmounts(company) && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Итог по известным суммам · есть неизвестные суммы</strong></div></div>}
    {company.issues.length > 0 && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Нужно проверить</strong><ul>{company.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div></div>}
    {positive(company.debt) && positive(company.advance) && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Есть долг и нераспределённый аванс</strong><p>Долг {money(company.debt)} · аванс {money(company.advance)}</p></div></div>}
    <dl className="overview-company-summary"><div><dt>{side === 'suppliers' ? 'Закуплено' : 'Продано'}</dt><dd>{money(company.shipped)}</dd></div><div><dt>{supplierScope ? 'Зачтено по вашим закупкам' : side === 'suppliers' ? 'Оплачено поставщику' : 'Поступило от клиента'}</dt><dd>{money(company.incoming)}</dd></div><div><dt>Учтено в погашение</dt><dd>{money(company.allocated)}</dd></div></dl>
    <section className="overview-card overview-transactions" aria-labelledby="organization-transactions-title"><div className="overview-card-heading"><div><h3 id="organization-transactions-title">История операций <span>{visible.length}</span></h3></div><div className="overview-transaction-controls"><select aria-label="Тип операций контрагента" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">Все операции</option><option value="shipment">{side === 'suppliers' ? 'Закупки' : 'Отгрузки'}</option><option value="receipt">{side === 'suppliers' ? 'Оплаты поставщику' : 'Поступления клиента'}</option></select><LedgerSort value={sort} onChange={setSort}/></div></div>
      {positive(company.openingPaid) && <p className="overview-opening-note">Ранее учтённая оплата: {money(company.openingPaid)} · без банковской операции</p>}
      {visible.length ? <ol className="overview-transaction-list">{visible.map(entry => <li key={`${entry.type}:${entry.item.id}`} className="overview-transaction" data-type={entry.type} data-transaction-id={entry.item.id}><details><summary><span className={`overview-transaction-icon is-${entry.type}`} aria-hidden="true">{entry.type === 'shipment' ? <Truck size={18}/> : <ArrowDownLeft size={18}/>}</span><span className="overview-transaction-title"><strong>{entry.type === 'shipment' ? shipmentTitle(entry.item, side) : paymentTitle(entry.item, side)}</strong><small>{date(entry.date)}{entry.type === 'receipt' ? ` · ${entry.item.bank}` : ''}</small>{entry.type === 'receipt' && entry.item.amountIsScoped && <small>Часть платежа по вашим операциям</small>}{entry.type === 'shipment' && entry.item.issue && <span className="overview-issue-badge">Требует проверки</span>}</span><strong className={`overview-transaction-amount is-${entry.type}`}>{entry.type === 'receipt' ? signedMoney(entry.item.amount) : entry.item.amount === null ? 'Сумма неизвестна' : signedMoney(new Exact(entry.item.amount).negated().toFixed(2))}</strong><ChevronRight size={17} aria-hidden="true"/></summary><div className="overview-transaction-body">{entry.type === 'shipment' ? <PurchaseDetails shipment={entry.item} company={company} organization={organization} side={side} onPayment={id => focusTransaction(id, 'receipt')}/> : <PaymentDetails payment={entry.item} company={company} organization={organization} side={side} onShipment={id => focusTransaction(id, 'shipment')}/>}</div></details></li>)}</ol> : <div className="overview-empty"><Wallet size={28}/><h3>Операций пока нет</h3></div>}
    </section>
  </section>
}

function PurchaseDetails({ shipment, company, organization, side, onPayment }: { shipment: SettlementShipment; company: SettlementCompany; organization: string; side: Side; onPayment: (id: string) => void }) {
  const payments = company.receipts.flatMap(payment => payment.allocations.filter(row => row.shipmentId === shipment.id).map(allocation => ({ payment, allocation })))
  return <><dl className="overview-operation-data"><div><dt>Наша организация</dt><dd>{organization}</dd></div><div><dt>Документ</dt><dd>{shipmentTitle(shipment, side)}</dd></div><div><dt>Дата</dt><dd>{date(shipment.date)}</dd></div><div><dt>Идентификатор отгрузки</dt><dd>{shipment.id}</dd></div><div><dt>{side === 'suppliers' ? 'Сумма закупки' : 'Сумма продажи'}</dt><dd>{money(shipment.amount)}</dd></div><div><dt>Оплачено всего</dt><dd>{money(shipment.paid)}</dd></div><div><dt>Оплачено ранее</dt><dd>{money(shipment.openingPaid)}</dd></div><div><dt>Учтено из банковских оплат</dt><dd>{money(shipment.bankPaid)}</dd></div><div><dt>Остаток долга</dt><dd className={shipment.debt && positive(shipment.debt) ? 'overview-text-debt' : ''}>{money(shipment.debt)}</dd></div></dl>
    {shipment.issue && <p className="overview-operation-issue"><AlertCircle size={15}/>{shipment.issue}</p>}
    <div className="overview-allocation-trace"><h4>Какими платежами погашено</h4>{payments.length ? <ul>{payments.map(({ payment, allocation }) => <li key={`${payment.id}:${allocation.shipmentId}`}><button type="button" onClick={() => onPayment(payment.id)}>{paymentTitle(payment, side)} · {date(payment.date)}<ChevronRight size={14}/></button><p>{payment.bank} · {organization}<br/>Счёт {payment.account}<br/>Операция {payment.bankOperationId ?? payment.id}</p><dl><div><dt>{payment.amountIsScoped ? 'Сумма в вашей области' : 'Исходная сумма оплаты'}</dt><dd>{money(payment.amount)}</dd></div><div><dt>На эту {side === 'suppliers' ? 'закупку' : 'отгрузку'}</dt><dd>{money(allocation.amount)}</dd></div><div><dt>Остаток аванса по платежу</dt><dd>{payment.amountIsScoped ? 'Не показан в вашей области' : money(payment.advance)}</dd></div></dl></li>)}</ul> : <p>Распределённых банковских оплат пока нет.</p>}</div>
  </>
}

function PaymentDetails({ payment, company, organization, side, onShipment }: { payment: SettlementReceipt; company: SettlementCompany; organization: string; side: Side; onShipment: (id: string) => void }) {
  return <><dl className="overview-operation-data"><div><dt>Наша организация</dt><dd>{organization}</dd></div><div><dt>Банк</dt><dd>{payment.bank}</dd></div><div className="overview-operation-wide"><dt>Наш банковский счёт</dt><dd>{payment.account}</dd></div><div><dt>Дата платежа</dt><dd>{date(payment.date)}</dd></div><div><dt>Номер документа</dt><dd>{payment.documentNumber || 'Не передан банком'}</dd></div><div className="overview-operation-wide"><dt>Идентификатор операции банка</dt><dd>{payment.bankOperationId ?? payment.id}</dd></div><div><dt>{payment.amountIsScoped ? 'Сумма в вашей области' : 'Исходная сумма платежа'}</dt><dd>{money(payment.amount)}</dd></div><div><dt>{payment.amountIsScoped ? 'Зачтено по вашим операциям' : 'Распределено'}</dt><dd>{money(payment.allocated)}</dd></div><div><dt>Нераспределённый аванс</dt><dd>{payment.amountIsScoped ? 'Не показан в вашей области' : money(payment.advance)}</dd></div></dl>
    <div className="overview-purpose"><span>Назначение платежа</span><p>{payment.amountIsScoped ? 'Не показано в вашей области' : payment.purpose || 'Назначение платежа не передано'}</p></div>
    <div className="overview-allocation-trace"><h4>Куда распределён платёж</h4>{payment.allocations.length ? <ul>{payment.allocations.map(allocation => { const shipment = company.shipments.find(row => row.id === allocation.shipmentId); return <li key={`${allocation.shipmentId}:${allocation.paymentId}`}>
      {shipment ? <button type="button" onClick={() => onShipment(shipment.id)}>{shipmentTitle(shipment, side)} · {date(shipment.date)}<ChevronRight size={14}/></button> : <strong>{side === 'suppliers' ? 'Закупка' : 'Отгрузка'} {allocation.shipmentId}</strong>}
      <dl><div><dt>{side === 'suppliers' ? 'Исходная сумма закупки' : 'Исходная сумма продажи'}</dt><dd>{money(shipment?.amount)}</dd></div><div><dt>Из этого платежа</dt><dd>{money(allocation.amount)}</dd></div><div><dt>Текущий остаток долга</dt><dd>{money(shipment?.debt)}</dd></div></dl>
    </li> })}</ul> : <p>Платёж не распределён.</p>}</div>
  </>
}

const sourceStatuses = { ready: 'Выписка загружена', not_loaded: 'Выписка ещё не загружена', syncing: 'Выписка загружена частично', error: 'Ошибка загрузки выписки' }
function LedgerSources({ report }: { report: SettlementsReport }) {
  if (!report.sources.length) return null
  return <details className="overview-sources" open={report.sources.some(source => source.status !== 'ready')}><summary>Источники данных · {report.sources.length}</summary><ul>{report.sources.map(source => <li key={source.id}><strong>{source.name}</strong><span className={`overview-source-status is-${source.status}`}>{sourceStatuses[source.status]}</span><span>Последняя успешная загрузка: {source.lastSuccessAt ? date(source.lastSuccessAt) : 'Ещё не загружались'}</span><span>{source.from && source.to ? `${date(source.from)} — ${date(source.to)}` : 'Загруженный период не подтверждён'}</span>{source.lastError && <p className="overview-text-debt">{source.lastError}</p>}</li>)}</ul></details>
}
