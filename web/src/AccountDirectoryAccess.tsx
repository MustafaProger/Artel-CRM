import { sharedDirectories, type SharedDirectory } from './auth-model';
export default function AccountDirectoryAccess({ grants, privileged, enabled, onChange }: { grants: SharedDirectory[]; privileged: boolean; enabled: boolean; onChange: (grants: SharedDirectory[]) => void }) {
  return <div className="account-directory-access"><h4>Разделы справочника</h4>
    <p>Клиенты и их адреса видны при доступе к обзору, отгрузкам или рейсам. Остальные вкладки определяются галочками ниже. Обзор, отгрузки и работа показывают только связанные с сотрудником данные.</p>
    <p>Включённый общий справочник доступен целиком: просмотр, добавление, изменение и удаление.</p>
    <div className="account-section-grid">{sharedDirectories.filter(directory => directory.id !== 'paymentForms').map(directory => <label key={directory.id}><input type="checkbox" className="account-toggle" aria-label={`Справочник: ${directory.title}`} checked={privileged || grants.includes(directory.id)} disabled={privileged || !enabled} onChange={event => onChange(event.target.checked ? [...grants, directory.id] : grants.filter(id => id !== directory.id))}/><span>{directory.title}</span></label>)}</div>
  </div>;
}
