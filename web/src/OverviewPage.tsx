import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowDownLeft, ArrowLeft, ArrowUpRight, Building2, ChevronRight, CircleCheck, LoaderCircle, RefreshCw, Search, Truck, Wallet, X } from 'lucide-react'
import type { SettlementCompany, SettlementReceipt, SettlementShipment, SettlementSource, SettlementsReport } from './settlements-model'
import { OverviewDecimal as Exact, companyBalance, hasUnknownAmounts, needsReview, overviewMoney as money, overviewMonths, signedMoney, type OverviewPeriod } from './overview-model'
import './overview.css'

const positive = (value: string) => new Exact(value).gt(0)
const date = (value: string | null) => {
  if (!value) return 'Дата не указана'
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  return Number.isNaN(parsed.getTime()) ? 'Дата не указана' : parsed.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' })
}
const time = (value: string | null) => {
  if (!value) return 'Ещё не загружались'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Время не указано' : parsed.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
}
const monthLabel = (month: string, long = false) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('ru-RU', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit', timeZone: 'Europe/Moscow' })
const tone = (value: string) => new Exact(value).lt(0) ? 'debt' : positive(value) ? 'advance' : 'zero'
const balanceLabel = (company: SettlementCompany) => {
  if (!company.receipts.length && !company.shipments.length) return 'Операций пока нет'
  const balance = new Exact(companyBalance(company))
  return balance.lt(0) ? 'Долг компании' : balance.gt(0) ? 'Аванс' : 'Расчёты закрыты'
}
const shipmentTitle = (shipment: SettlementShipment) => `Отгрузка ${shipment.number ? `№ ${shipment.number}` : 'без номера'}`

export default function OverviewPage({ personalScope = false }: { personalScope?: boolean }) {
  const [data, setData] = useState<SettlementsReport | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'debt' | 'advance' | 'review'>('all')
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null)
  const [period, setPeriod] = useState<OverviewPeriod>('6')
  const activeRequest = useRef<AbortController | null>(null), requestNumber = useRef(0)
  const companyHeading = useRef<HTMLHeadingElement | null>(null)
  const refresh = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController(), request = ++requestNumber.current
    activeRequest.current = controller
    setLoading(true)
    try {
      const response = await fetch('/api/settlements', { signal: controller.signal, cache: 'no-store' })
      if (controller.signal.aborted || request !== requestNumber.current) return
      if (response.status === 401 || response.status === 403) {
        setData(null); setSelectedCompany(null); setUpdatedAt(null)
      }
      const result = await response.json()
      if (controller.signal.aborted || request !== requestNumber.current) return
      if (!response.ok) {
        throw new Error(result.error || 'Не удалось загрузить обзор.')
      }
      setData(result); setError(''); setUpdatedAt(new Date().toISOString())
    } catch (cause) {
      if (!controller.signal.aborted && request === requestNumber.current) setError(cause instanceof Error ? cause.message : 'Нет связи с сервером.')
    } finally {
      if (!controller.signal.aborted && request === requestNumber.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const interval = window.setInterval(visibleRefresh, 30_000)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
      activeRequest.current?.abort()
    }
  }, [refresh])
  useEffect(() => { if (selectedCompany) companyHeading.current?.focus() }, [selectedCompany])
  const term = query.trim().toLocaleLowerCase('ru-RU')
  const companies = useMemo(() => (data?.companies ?? []).filter(company =>
    (!term || `${company.name} ${company.inn ?? ''}`.toLocaleLowerCase('ru-RU').includes(term)) &&
    (filter === 'all' || filter === 'debt' && positive(company.debt) || filter === 'advance' && positive(company.advance) || filter === 'review' && needsReview(company)),
  ).sort((a, b) => new Exact(companyBalance(a)).cmp(companyBalance(b)) || a.name.localeCompare(b.name, 'ru')), [data, term, filter])
  const detail = data?.companies.find(company => company.key === selectedCompany)
  const reviewCount = (data?.review.length ?? 0) + (data?.companies.filter(needsReview).length ?? 0)
  const openCompany = (key: string) => setSelectedCompany(key)
  const closeCompany = () => {
    const previous = selectedCompany
    setSelectedCompany(null)
    requestAnimationFrame(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.overview-company-button')].find(element => element.dataset.companyKey === previous)
      button?.focus({ preventScroll: true })
    })
  }

  return <section className="overview-page" aria-label="Обзор клиентов">
    <div className="overview-heading"><div><span className="overview-eyebrow">{personalScope ? 'МОИ КЛИЕНТЫ' : 'ФИНАНСЫ КЛИЕНТОВ'}</span><h2>{detail ? 'Карточка компании' : 'Всё по вашим клиентам'}</h2><p>{personalScope ? 'Ваши компании, их отгрузки, пополнения и баланс.' : 'Компании, движение денег и текущий баланс в одном месте.'}</p></div><button type="button" className="button overview-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading && data ? 'Обновляем…' : 'Обновить'}</button></div>
    {error && <div className="overview-notice overview-error" role="alert"><AlertCircle size={18}/><div><strong>{error}</strong><p>{data ? `Показаны данные от ${time(updatedAt)}. Они могут быть неактуальны.` : 'Проверьте соединение и повторите загрузку.'}</p><button type="button" className="button" disabled={loading} onClick={() => void refresh()}>Повторить загрузку</button></div></div>}
    {!data ? <div className="overview-empty overview-card" role="status">{loading ? <><LoaderCircle size={28} className="spin"/><h3>Собираем обзор</h3><p>Загружаем компании, отгрузки и поступления.</p></> : <><Wallet size={30}/><h3>Обзор пока недоступен</h3><p>Попробуйте обновить данные.</p></>}</div> : <>
      <div className="overview-freshness"><span>{loading ? <LoaderCircle size={13} className="spin"/> : <CircleCheck size={13}/>}Обновлено: {time(updatedAt)}</span><span>Баланс за всю сохранённую историю</span></div>
      {selectedCompany ? detail ? <CompanyDetails company={detail} headingRef={companyHeading} onBack={closeCompany}/> : <div className="overview-empty overview-card"><Building2 size={30}/><h3>Компания больше не доступна</h3><p>Данные или доступ к компании изменились.</p><button type="button" className="button" onClick={closeCompany}><ArrowLeft size={15}/>Назад к компаниям</button></div> : <>
        <div className="overview-totals" aria-label="Итоги по доступным компаниям"><Total label="Долг клиентов" value={data.totals.debt} kind="debt" hint={`${data.companies.filter(company => positive(company.debt)).length} компаний с долгом`}/><Total label="Авансы клиентов" value={data.totals.advance} kind="advance" hint={`${data.companies.filter(company => positive(company.advance)).length} компаний с авансом`}/><Total label="Пополнения" value={data.totals.incoming} kind="incoming" hint="Подтверждённые поступления"/><Total label="Отгрузки" value={data.totals.shipped} kind="shipped" hint={`${data.companies.reduce((count, company) => count + company.shipments.length, 0)} отгрузок за всё время`}/></div>
        {data.companies.some(hasUnknownAmounts) && <UnknownNotice/>}
        <div className="overview-charts"><MovementChart companies={data.companies} period={period} onPeriodChange={setPeriod}/><DebtChart companies={data.companies} onSelect={openCompany}/></div>
        <section className="overview-card overview-companies" aria-labelledby="overview-companies-title"><div className="overview-card-heading"><div><h3 id="overview-companies-title">{personalScope ? 'Мои компании' : 'Компании'} <span>{companies.length}</span></h3><p>Откройте компанию, чтобы посмотреть все операции.</p></div>{reviewCount > 0 && <button type="button" className="overview-review-shortcut" onClick={() => setFilter('review')}><AlertCircle size={14}/>На проверку: {reviewCount}</button>}</div>
          <div className="overview-toolbar"><label className="overview-search"><Search size={18}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название или ИНН" aria-label="Поиск компаний по названию или ИНН"/>{query && <button type="button" aria-label="Очистить поиск компаний" onClick={() => setQuery('')}><X size={16}/></button>}</label><select aria-label="Фильтр компаний" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">Все компании</option><option value="debt">С долгом</option><option value="advance">С авансом</option><option value="review">Требуют проверки</option></select></div>
          <div className="overview-list-caption" aria-hidden="true"><span>Компания</span><span>Баланс</span></div>
          {companies.length ? <ul className="overview-company-list">{companies.map(company => <li key={company.key}><button type="button" className="overview-company-button" data-company-key={company.key} data-testid="overview-company" onClick={() => openCompany(company.key)}><span className="overview-company-avatar" aria-hidden="true"><Building2 size={19}/></span><span className="overview-company-identity"><strong>{company.name}</strong><small>{company.inn ? `ИНН ${company.inn}` : 'ИНН не указан'}<span aria-hidden="true"> · </span>{company.shipments.length} отгрузок</small>{needsReview(company) && <span className="overview-issue-badge">Требует проверки</span>}</span><span className="overview-company-amount"><Balance company={company}/><small>{hasUnknownAmounts(company) ? 'Баланс требует проверки' : balanceLabel(company)}</small></span><ChevronRight size={18} aria-hidden="true"/></button></li>)}</ul> : <div className="overview-empty"><Building2 size={30}/><h3>{query || filter !== 'all' ? 'Компании не найдены' : 'Компаний пока нет'}</h3><p>{query || filter !== 'all' ? 'Попробуйте другое название или измените фильтр.' : personalScope ? 'Здесь появятся закреплённые за вами компании и их операции.' : 'Здесь появятся компании, их отгрузки и подтверждённые поступления.'}</p>{(query || filter !== 'all') && <button type="button" className="button" onClick={() => { setQuery(''); setFilter('all') }}>Сбросить фильтры</button>}</div>}
          <div className="overview-list-note"><span><i className="overview-dot is-debt"/>Минус — долг компании</span><span><i className="overview-dot is-advance"/>Плюс — аванс</span></div>
        </section>
        {data.review.length > 0 && <ReviewQueue data={data} query={term} visible={filter === 'all' || filter === 'review'}/>}
        {data.sources.length > 0 && <BankSources sources={data.sources}/>}
      </>}
    </>}
  </section>
}

function Total({ label, value, kind, hint }: { label: string; value: string; kind: 'debt' | 'advance' | 'incoming' | 'shipped'; hint: string }) {
  return <div className={`overview-total overview-card overview-total-${kind}`} data-total={kind}><span>{label}{kind === 'debt' ? <ArrowUpRight size={17}/> : kind === 'shipped' ? <Truck size={17}/> : <ArrowDownLeft size={17}/>}</span><strong>{kind === 'debt' ? signedMoney(new Exact(value).negated().toFixed(2)) : kind === 'advance' ? signedMoney(value) : money(value)}</strong><small>{hint}</small></div>
}
function Balance({ company }: { company: SettlementCompany }) {
  const value = companyBalance(company)
  return <strong className="overview-balance" data-balance={value} data-tone={tone(value)} data-testid="overview-company-balance">{signedMoney(value)}</strong>
}
function UnknownNotice() {
  return <div className="overview-notice"><AlertCircle size={18}/><div><strong>Некоторые суммы требуют проверки</strong><p>В итогах учтены только известные суммы. Если сумма отгрузки или прежняя оплата неизвестна, нулевой баланс ещё не означает, что компания рассчиталась.</p></div></div>
}

function MovementChart({ companies, period, onPeriodChange }: { companies: SettlementCompany[]; period: OverviewPeriod; onPeriodChange: (period: OverviewPeriod) => void }) {
  const chart = useMemo(() => overviewMonths(companies, period), [companies, period])
  const [selected, setSelected] = useState<string | null>(null)
  const activeMonth = chart.months.find(month => month.month === selected) ?? [...chart.months].reverse().find(month => month.receipts || month.shipments) ?? chart.months[chart.months.length - 1]
  const max = chart.months.reduce((largest, month) => Exact.max(largest, month.incoming, month.shipped), new Exact(0))
  const height = (value: string) => max.isZero() ? 0 : new Exact(value).div(max).times(100).toNumber()
  const incoming = chart.months.reduce((total, month) => total.plus(month.incoming), new Exact(0)).toFixed(2)
  const shipped = chart.months.reduce((total, month) => total.plus(month.shipped), new Exact(0)).toFixed(2)
  return <section className="overview-card overview-movement" aria-labelledby="overview-movement-title"><div className="overview-card-heading"><div><h3 id="overview-movement-title">Движение денег</h3><p>Пополнения и списания по отгрузкам</p></div><select aria-label="Период диаграммы" data-testid="overview-period" value={period} onChange={event => { setSelected(null); onPeriodChange(event.target.value as OverviewPeriod) }}><option value="6">6 месяцев</option><option value="12">12 месяцев</option><option value="all">За всё время</option></select></div>
    <div className="overview-chart-totals"><span><i className="overview-dot is-advance"/>Пополнения<strong>{money(incoming)}</strong></span><span><i className="overview-dot is-debt"/>Отгрузки<strong>{money(shipped)}</strong></span></div>
    <figure className="overview-figure"><figcaption className="overview-sr-only">Движение денег по месяцам. Выберите месяц, чтобы узнать суммы и количество операций. Высота столбцов пропорциональна сумме.</figcaption><div className="overview-chart-scroll" role="group" aria-label="Месяцы движения денег"><div className={`overview-bars${chart.months.length > 12 ? ' is-wide' : ''}`} style={chart.months.length > 12 ? { minWidth: `${chart.months.length * 48}px` } : undefined}>{chart.months.map(month => <button type="button" key={month.month} className={`overview-month-button${activeMonth?.month === month.month ? ' is-selected' : ''}`} data-month={month.month} aria-pressed={activeMonth?.month === month.month} aria-label={`${monthLabel(month.month, true)}: пополнения ${money(month.incoming)}, отгрузки ${money(month.shipped)}`} onClick={() => setSelected(month.month)}><span className="overview-bar-pair" aria-hidden="true"><span className="overview-bar is-incoming" style={{ height: `${height(month.incoming)}%` }}/><span className="overview-bar is-shipped" style={{ height: `${height(month.shipped)}%` }}/></span><span className="overview-month-label">{monthLabel(month.month)}</span></button>)}</div></div>
      <div className="overview-chart-detail" aria-live="polite">{activeMonth && <><strong>{monthLabel(activeMonth.month, true)}</strong><span>Пополнения <b>{money(activeMonth.incoming)}</b><small>{activeMonth.receipts} операций</small></span><span>Отгрузки <b>{money(activeMonth.shipped)}</b><small>{activeMonth.shipments} отгрузок</small></span></>}</div>
    </figure>{max.isZero() && <p className="overview-chart-note">В выбранном периоде нет операций с известной суммой.</p>}{(chart.undated > 0 || chart.unknown > 0) && <p className="overview-chart-note">{chart.undated > 0 ? `Операции без даты (${chart.undated}) не показаны на диаграмме. ` : ''}{chart.unknown > 0 ? `Сумма ${chart.unknown} отгрузок неизвестна и не включена в столбцы.` : ''}</p>}
  </section>
}

function DebtChart({ companies, onSelect }: { companies: SettlementCompany[]; onSelect: (key: string) => void }) {
  const debtors = [...companies].filter(company => positive(company.debt)).sort((a, b) => new Exact(b.debt).cmp(a.debt)).slice(0, 5)
  const maximum = debtors[0]?.debt ?? '0'
  return <section className="overview-card overview-debtors" aria-labelledby="overview-debtors-title"><div className="overview-card-heading"><div><h3 id="overview-debtors-title">Кто должен больше</h3><p>До пяти компаний · текущий долг</p></div><ArrowUpRight size={19}/></div>{debtors.length ? <ol className="overview-debt-list">{debtors.map((company, index) => <li key={company.key}><button type="button" onClick={() => onSelect(company.key)} aria-label={`Открыть ${company.name}, долг ${money(company.debt)}`}><span className="overview-rank">{index + 1}</span><span className="overview-debtor-info"><span><strong>{company.name}</strong><b>{signedMoney(new Exact(company.debt).negated().toFixed(2))}</b></span><span className="overview-debt-track" aria-hidden="true"><span style={{ width: `${new Exact(company.debt).div(maximum).times(100).toNumber()}%` }}/></span></span></button></li>)}</ol> : <div className="overview-empty overview-no-debt"><CircleCheck size={32}/><h3>Открытых долгов нет</h3><p>{companies.some(hasUnknownAmounts) ? 'Есть неизвестные суммы. Проверьте отмеченные компании.' : 'По известным суммам задолженности нет.'}</p></div>}<p className="overview-chart-note">Нажмите на компанию, чтобы открыть её операции.</p></section>
}

type LedgerEntry = { type: 'receipt'; date: string; item: SettlementReceipt } | { type: 'shipment'; date: string | null; item: SettlementShipment }
function CompanyDetails({ company, headingRef, onBack }: { company: SettlementCompany; headingRef: React.RefObject<HTMLHeadingElement | null>; onBack: () => void }) {
  const [filter, setFilter] = useState<'all' | 'receipt' | 'shipment'>('all')
  const transactions = useMemo(() => {
    const entries: LedgerEntry[] = [...company.receipts.map(item => ({ type: 'receipt' as const, date: item.date, item })), ...company.shipments.map(item => ({ type: 'shipment' as const, date: item.date, item }))]
    return entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.type.localeCompare(b.type) || a.item.id.localeCompare(b.item.id))
  }, [company])
  const visible = transactions.filter(entry => filter === 'all' || filter === entry.type)
  const focusShipment = (id: string) => {
    setFilter('all')
    requestAnimationFrame(() => {
      const entry = [...document.querySelectorAll<HTMLElement>('.overview-transaction[data-type="shipment"]')].find(element => element.dataset.transactionId === id)
      const details = entry?.querySelector('details')
      if (details) details.open = true
      entry?.scrollIntoView({ block: 'center' })
      entry?.querySelector('summary')?.focus({ preventScroll: true })
    })
  }
  return <section className="overview-company-details" data-company-key={company.key} aria-label={`Операции компании ${company.name}`}><button type="button" className="overview-back" onClick={onBack}><ArrowLeft size={17}/>Назад к компаниям</button><div className="overview-card overview-company-hero"><div><span className="overview-eyebrow">{company.inn ? `ИНН ${company.inn}` : 'ИНН НЕ УКАЗАН'}</span><h3 ref={headingRef} tabIndex={-1}>{company.name}</h3><p>{hasUnknownAmounts(company) ? 'Баланс требует проверки' : 'Текущий баланс компании'}</p></div><div className="overview-hero-balance"><Balance company={company}/><span>{hasUnknownAmounts(company) ? 'По известным суммам' : balanceLabel(company)}</span></div></div>
    {hasUnknownAmounts(company) && <UnknownNotice/>}{positive(company.debt) && positive(company.advance) && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Есть неоплаченные отгрузки и нераспределённый аванс</strong><p>Показан общий баланс: аванс {money(company.advance)} минус долг по отгрузкам {money(company.debt)}. Проверьте расчёты в истории операций.</p></div></div>}{company.issues.length > 0 && <div className="overview-notice"><AlertCircle size={18}/><div><strong>Нужно проверить</strong><ul>{company.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div></div>}
    <dl className="overview-company-summary"><div><dt>Пополнения</dt><dd>{money(company.incoming)}</dd></div><div><dt>Списано по отгрузкам</dt><dd>{money(company.shipped)}</dd></div><div><dt>Ранее учтённая оплата</dt><dd>{money(company.openingPaid)}</dd></div></dl>
    <section className="overview-card overview-transactions" data-testid="overview-transactions" aria-labelledby="overview-transactions-title"><div className="overview-card-heading"><div><h3 id="overview-transactions-title">История операций <span>{visible.length}</span></h3><p>От новых к старым · все суммы в рублях</p></div><select aria-label="Тип операций компании" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">Все операции</option><option value="receipt">Пополнения</option><option value="shipment">Отгрузки</option></select></div>{positive(company.openingPaid) && <p className="overview-opening-note">Ранее учтённая оплата {money(company.openingPaid)} входит в баланс. Она показана отдельно: дата её поступления в этих данных отсутствует.</p>}
      {visible.length ? <ol className="overview-transaction-list">{visible.map(entry => <li key={`${entry.type}-${entry.item.id}`} className="overview-transaction" data-type={entry.type} data-transaction-id={entry.item.id}><details><summary><span className={`overview-transaction-icon is-${entry.type}`} aria-hidden="true">{entry.type === 'receipt' ? <ArrowDownLeft size={18}/> : <Truck size={18}/>}</span><span className="overview-transaction-title"><strong>{entry.type === 'receipt' ? 'Пополнение' : shipmentTitle(entry.item)}</strong><small>{date(entry.date)}{entry.type === 'receipt' ? ` · ${entry.item.bank}` : ''}</small>{entry.type === 'shipment' && entry.item.issue && <span className="overview-issue-badge">Требует проверки</span>}</span><strong className={`overview-transaction-amount is-${entry.type}`}>{entry.type === 'receipt' ? signedMoney(entry.item.amount) : entry.item.amount === null ? 'Сумма неизвестна' : signedMoney(new Exact(entry.item.amount).negated().toFixed(2))}</strong><ChevronRight size={17} aria-hidden="true"/></summary><div className="overview-transaction-body">{entry.type === 'receipt' ? <ReceiptDetails receipt={entry.item} company={company} onShipment={focusShipment}/> : <ShipmentDetails shipment={entry.item}/>}</div></details></li>)}</ol> : <div className="overview-empty"><Wallet size={28}/><h3>Операций пока нет</h3><p>{filter === 'all' ? 'Здесь появятся пополнения и списания по отгрузкам компании.' : 'Выберите другой тип операций.'}</p></div>}
    </section>
  </section>
}
function ShipmentDetails({ shipment }: { shipment: SettlementShipment }) {
  return <><dl className="overview-operation-data"><div><dt>Отгрузка</dt><dd>{shipment.number ? `№ ${shipment.number}` : 'Без номера'}</dd></div><div><dt>Дата</dt><dd>{date(shipment.date)}</dd></div><div><dt>Сумма отгрузки</dt><dd>{money(shipment.amount)}</dd></div><div><dt>Оплачено всего</dt><dd>{money(shipment.paid)}</dd></div><div><dt>Оплачено ранее</dt><dd>{money(shipment.openingPaid)}</dd></div><div><dt>Учтено из поступлений</dt><dd>{money(shipment.bankPaid)}</dd></div><div><dt>Неоплаченная часть</dt><dd className={shipment.debt && positive(shipment.debt) ? 'overview-text-debt' : ''}>{money(shipment.debt)}</dd></div></dl>{shipment.issue && <p className="overview-operation-issue"><AlertCircle size={15}/>{shipment.issue}</p>}</>
}
function ReceiptDetails({ receipt, company, onShipment }: { receipt: SettlementReceipt; company: SettlementCompany; onShipment: (id: string) => void }) {
  return <><dl className="overview-operation-data"><div><dt>Банк</dt><dd>{receipt.bank}</dd></div><div><dt>Компания-получатель</dt><dd>{receipt.company}</dd></div><div className="overview-operation-wide"><dt>Счёт зачисления</dt><dd>{receipt.account}</dd></div><div><dt>Учтено в оплату отгрузок</dt><dd>{money(receipt.allocated)}</dd></div><div><dt>Остаток аванса</dt><dd>{money(receipt.advance)}</dd></div></dl><div className="overview-purpose"><span>Назначение платежа</span><p>{receipt.purpose || 'Назначение платежа не передано'}</p></div>{receipt.allocations.length > 0 && <div className="overview-receipt-allocations"><span>Связанные отгрузки</span><ul>{receipt.allocations.map(allocation => { const shipment = company.shipments.find(row => row.id === allocation.shipmentId); return <li key={`${allocation.shipmentId}-${allocation.paymentId}`}>{shipment ? <button type="button" onClick={() => onShipment(shipment.id)}>{shipmentTitle(shipment)} · {date(shipment.date)}</button> : <span>Отгрузка</span>}<strong>{money(allocation.amount)}</strong></li> })}</ul></div>}</>
}
const sourceStatus: Record<SettlementSource['status'], string> = { not_loaded: 'Выписка ещё не загружена', ready: 'Выписка загружена', error: 'Ошибка загрузки', syncing: 'Загрузка не завершена' }
function BankSources({ sources }: { sources: SettlementSource[] }) {
  return <details className="overview-sources" open={sources.some(source => source.status !== 'ready')}><summary>Источники данных · банковские выписки <span>{sources.length}</span></summary><p>Расчёт использует сохранённые поступления. Выписки обновляются в разделе «Платежи».</p><ul>{sources.map(source => <li key={source.id} data-connection-id={source.id}><strong>{source.name}</strong><span className={`overview-source-status is-${source.status}`}>{source.status === 'syncing' && <LoaderCircle size={12} className="spin"/>}{sourceStatus[source.status]}</span><span>Последняя успешная загрузка: {time(source.lastSuccessAt)}</span><span>{source.from && source.to ? `Последний загруженный период: ${date(source.from)} — ${date(source.to)}` : 'Загруженный период не подтверждён'}</span>{source.status === 'syncing' && <p>Полный период ещё не загружен. Учтены только уже сохранённые поступления.</p>}{source.lastError && <p className="overview-text-debt">{source.lastError}</p>}</li>)}</ul></details>
}
function ReviewQueue({ data, query, visible }: { data: SettlementsReport; query: string; visible: boolean }) {
  const rows = data.review.filter(row => !query || `${row.name} ${row.inn ?? ''}`.toLocaleLowerCase('ru-RU').includes(query))
  if (!visible || !rows.length) return null
  return <section className="overview-card overview-review" aria-labelledby="overview-review-title"><div className="overview-card-heading"><div><h3 id="overview-review-title">Поступления на проверку <span>{rows.length}</span></h3><p>Эти операции пока не включены в баланс компаний.</p></div><AlertCircle size={19}/></div><ul>{rows.map(row => <li key={row.id} data-connection-id={row.connectionId}><div><strong>{row.name}</strong><p>{row.inn ? `ИНН ${row.inn}` : 'ИНН не указан'} · {date(row.date)}</p><p>{row.bank} · {row.company}<br/>Счёт {row.account}</p></div><b>{money(row.amount, row.currency === 'RUB' || row.currency === '643' ? '₽' : row.currency)}</b><p className="overview-review-reason">{row.reason}</p></li>)}</ul></section>
}
