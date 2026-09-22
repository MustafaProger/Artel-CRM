import { RefreshCw, Unplug } from 'lucide-react'
import BankConnectionHeader from './BankConnectionHeader'

export default function SberLayout({ bank, onBack }: { bank: { bankName: string; company: string }; onBack: () => void }) {
  return <>
    <BankConnectionHeader bankName={bank.bankName} company={bank.company} provider="sber" onBack={onBack}
      actions={<><button className="button" disabled><Unplug size={16}/>Подключение</button><button className="button primary" disabled><RefreshCw size={16}/>Синхронизировать</button></>}
      fields={[{ label: 'Расчётный счёт', value: 'Не подключён' }, { label: 'Статус подключения', value: 'Доступ не настроен' }]}>
      <div className="bank-period"><label>Период с<input aria-label="Период с" type="date" disabled/></label><span aria-hidden="true">—</span><label>Период по<input aria-label="Период по" type="date" disabled/></label></div>
      <div className="bank-connection-line"><span className="bank-state not_configured">Не подключён</span><span>Обновление выписок будет доступно после подключения счёта.</span></div>
    </BankConnectionHeader>
    <section className="panel bank-empty bank-disconnected"><span className="bank-emblem"><Unplug size={28}/></span><h3>СберБизнес ещё не подключён</h3><p>После настройки доступа здесь появятся выписки и операции компании {bank.company}.</p></section>
  </>
}
