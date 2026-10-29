import type { ReactNode } from 'react'
import { ArrowLeft, Building2 } from 'lucide-react'

type Props = {
  bankName: string
  company: string
  provider: 'sber' | 'tbank'
  onBack: () => void
  actions: ReactNode
  fields: { label: string; value: ReactNode }[]
  children: ReactNode
}

export default function BankConnectionHeader({ bankName, company, provider, onBack, actions, fields, children }: Props) {
  return <>
    <button className="bank-back bank-detail-back" onClick={onBack}><ArrowLeft size={16}/>Все подключения</button>
    <section className={`panel bank-account-panel bank-${provider}`} aria-label="Счёт и период выписки">
      <div className="bank-section-heading">
        <div className="bank-account-heading"><span className="bank-emblem"><Building2 size={22}/></span><div><h2>{bankName}</h2><p>{company}</p></div></div>
        <div className="bank-heading-actions">{actions}</div>
      </div>
      <dl className="bank-account-fields">{fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
      {children}
    </section>
  </>
}
