import { ArrowDownToLine, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { downloadFile } from './utils'
import { apiFetch } from './workspace-api'

function useExportDownload() {
  const request = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => () => request.current?.abort(), [])

  async function download(url: string, filename: string) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    try {
      const response = await apiFetch(url, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({}))
        throw new Error(error || 'Не удалось подготовить файл. Попробуйте ещё раз.')
      }
      const file = await response.blob()
      if (!controller.signal.aborted) downloadFile(filename, file)
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Не удалось скачать файл. Попробуйте ещё раз.')
      }
    } finally {
      request.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }

  return { download, pending, error, clearError: () => setError('') }
}

function ExportButton({ pending, label, format = 'Excel' }: { pending: boolean; label: string; format?: 'Excel' | 'ZIP' }) {
  return <button type="submit" className="button" aria-label={pending ? 'Подготовка файла' : label} disabled={pending}>
    {pending ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <ArrowDownToLine size={16} aria-hidden="true"/>}
    {pending ? 'Подготовка…' : format}
  </button>
}

export default function SettingsExports({ directories, documents, shipments }: { directories: boolean; documents: boolean; shipments: boolean }) {
  if (!directories && !documents && !shipments) return null

  return <section className="panel personal-settings-card settings-export" aria-labelledby="settings-export-title">
    <header className="personal-settings-card-heading">
      <span aria-hidden="true"><ArrowDownToLine size={20}/></span>
      <h2 id="settings-export-title">Выгрузка данных</h2>
    </header>
    {shipments && <ShipmentExport/>}
    {directories && <SingleFileExport id="directory-export-title" title="Справочники" format="Excel"
      label="Скачать Excel со справочниками" url="/api/directories/export.xlsx" filename="Артэль-справочники.xlsx"/>}
    {documents && <SingleFileExport id="document-export-title" title="Документы" format="ZIP"
      label="Скачать ZIP со всеми документами" url="/api/documents/export.zip" filename="Артэль-документы.zip"/>}
  </section>
}

function SingleFileExport({ id, title, format, label, url, filename }: {
  id: string; title: string; format: 'Excel' | 'ZIP'; label: string; url: string; filename: string
}) {
  const { download, pending, error } = useExportDownload()
  return <form className="settings-export-form" aria-labelledby={id} aria-busy={pending} onSubmit={event => {
    event.preventDefault()
    void download(url, filename)
  }}>
    <div className="settings-export-row settings-export-single">
      <h3 id={id}>{title}</h3>
      <ExportButton pending={pending} label={label} format={format}/>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>
}

function ShipmentExport() {
  const { download, pending, error, clearError } = useExportDownload()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!from || !to || from > to) return
    const query = new URLSearchParams({ from, to })
    void download(`/api/shipments/export.xlsx?${query}`, `Артэль-отгрузки-${from}—${to}.xlsx`)
  }

  return <form className="settings-export-form" aria-labelledby="shipment-export-title" aria-busy={pending} onSubmit={submit}>
    <h3 id="shipment-export-title">Отгрузки за период</h3>
    <div className="settings-export-row">
      <div className="settings-export-dates" role="group" aria-label="Период отгрузок">
        <label><span>С</span>
          <input type="date" aria-label="Дата с" value={from} max={to || undefined} required onChange={event => {
            clearError()
            setFrom(event.target.value)
          }}/>
        </label>
        <label><span>По</span>
          <input type="date" aria-label="Дата по" value={to} min={from || undefined} required onChange={event => {
            clearError()
            setTo(event.target.value)
          }}/>
        </label>
      </div>
      <ExportButton pending={pending} label="Скачать Excel с отгрузками"/>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>
}
