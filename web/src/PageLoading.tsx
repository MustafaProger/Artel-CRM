import './page-loading.css'
import { Menu } from 'lucide-react'

/** Module and prerequisite loading has no knowledge of the final page layout. */
export default function PageLoading({ label = 'Загрузка…', title, onOpenMenu, menuOpen = false }: { label?: string; title?: string; onOpenMenu?: () => void; menuOpen?: boolean }) {
  return <div className="page-loading-stage">
    {title && <div className="page-heading page-heading-compact"><h1>{title}</h1>{onOpenMenu && <button className="icon-button page-menu" aria-label="Открыть меню" aria-controls="app-navigation" aria-expanded={menuOpen} onClick={onOpenMenu}><Menu size={22}/></button>}</div>}
    <div className="page-loading" role="status"><span className="page-loading__spinner" aria-hidden="true"/><span>{label}</span></div>
  </div>
}
