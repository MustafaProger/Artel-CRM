import { ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Search, Unplug } from 'lucide-react'

export default function SberLayout({ bank, onBack }: { bank: { bankName: string; company: string }; onBack: () => void }) {
  return <>
    <div className="bank-section-heading"><div><button className="bank-back" onClick={onBack}><ArrowLeft size={16}/>Все подключения</button><h2>{bank.bankName} · {bank.company}</h2><p>Выписки по счетам · макет</p></div><div className="bank-heading-actions"><button className="button" disabled><Unplug size={16}/>Подключение</button><button className="button primary" disabled><RefreshCw size={16}/>Синхронизировать</button></div></div>
    <div className="bank-period"><label>Период с<input aria-label="Период с" type="date" disabled/></label><span>—</span><label>по<input aria-label="Период по" type="date" disabled/></label></div>
    <div className="bank-connection-line"><span className="bank-state not_configured">Макет</span><span>Счета ещё не подключены</span></div>
    <div className="panel bank-ledger">
      <div className="bank-ledger-title"><div><h3>Операции по счетам</h3><p>0 операций</p></div><button className="button" disabled><ArrowDownToLine size={16}/>Экспорт CSV</button></div>
      <div className="bank-filters"><label className="bank-search"><Search size={17}/><input aria-label="Поиск банковских операций" placeholder="Контрагент, ИНН, назначение или № документа" disabled/></label><label><span>Направление</span><select aria-label="Направление операции" disabled><option>Все направления</option></select></label><label><span>Наш счёт</span><select aria-label="Наш счёт" disabled><option>Все счета</option></select></label><label><span>Статус банка</span><select aria-label="Статус банка" disabled><option>Все статусы</option></select></label></div>
      <div className="bank-totals"><p className="bank-muted">Нет загруженных операций</p></div>
      <div className="bank-empty"><Unplug size={30}/><h3>СберБизнес ещё не подключён</h3><p>Здесь будет выписка по счетам компании.</p></div>
      <div className="bank-pagination"><label>На странице<select aria-label="Операций на странице" disabled><option>25</option></select></label><span>0 операций</span><div><button className="icon-button" aria-label="Предыдущая страница операций" disabled><ChevronLeft size={17}/></button><span>1 / 1</span><button className="icon-button" aria-label="Следующая страница операций" disabled><ChevronRight size={17}/></button></div></div>
    </div>
  </>
}
