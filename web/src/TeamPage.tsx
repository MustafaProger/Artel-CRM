import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  ChevronDown,
  CircleDashed,
  FileSpreadsheet,
  Info,
  LockKeyhole,
  Search,
  Settings2,
  ShieldCheck,
  Truck,
  UserRound,
  UsersRound,
  Warehouse,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import './team.css';

type TeamPageProps = {
  managerLabels: { name: string; shipmentCount: number }[];
};

type Permission = { label: string; value: string; allowed: boolean };
type Role = {
  id: string;
  name: string;
  caption: string;
  icon: LucideIcon;
  proposed?: boolean;
  summary: string;
  scope: string;
  note: string;
  permissions: Permission[];
};

const fullPermissions: Permission[] = [
  { label: 'Компании и отгрузки', value: 'Просмотр, создание, изменение и удаление', allowed: true },
  { label: 'Финансы и отчёты', value: 'Все данные, отчёты и экспорт', allowed: true },
  { label: 'Импорт и распределение', value: 'Загрузка данных и назначение владельцев', allowed: true },
  { label: 'Команда и роли', value: 'Управление пользователями и доступом', allowed: true },
  { label: 'Изменения в Работе', value: 'Автор и время изменений в Работе', allowed: true },
];

const roles: Role[] = [
  {
    id: 'director', name: 'Директор', caption: 'Полный обзор бизнеса', icon: ShieldCheck,
    summary: 'Все направления бизнеса в одном пространстве.',
    scope: 'Все компании, отгрузки и финансовые данные, включая записи без владельца.',
    note: 'Директор управляет пользователями, справочниками, отгрузками и рабочими записями. Последнего директора нельзя отключить.',
    permissions: fullPermissions,
  },
  {
    id: 'admin', name: 'Администратор', caption: 'Данные и управление доступом', icon: Settings2,
    summary: 'Подготовка данных и организация работы команды.',
    scope: 'Все записи, включая нераспределённые компании и отгрузки.',
    note: 'Администратор управляет пользователями, справочниками и рабочими данными.',
    permissions: fullPermissions,
  },
  {
    id: 'manager', name: 'Менеджер', caption: 'Задачи и свои отгрузки', icon: UserRound,
    summary: 'Работа со своим портфелем клиентов.',
    scope: 'Назначенные рабочие записи и отгрузки, связанные с сотрудником учётной записи. Общие справочники доступны для чтения.',
    note: 'Задачу можно передать другому сотруднику. После передачи она доступна новому исполнителю; директор и администратор видят все задачи.',
    permissions: [
      { label: 'Общие справочники', value: 'Только просмотр', allowed: true },
      { label: 'Свои отгрузки', value: 'Просмотр, создание, изменение и экспорт', allowed: true },
      { label: 'Работа', value: 'Назначенные задачи, компании и заметки', allowed: true },
      { label: 'Финансовая выписка и общие сводки', value: 'Доступ не предусмотрен', allowed: false },
      { label: 'Удаление, импорт и управление ролями', value: 'Доступ не предусмотрен', allowed: false },
    ],
  },
  {
    id: 'accountant', name: 'Бухгалтер', caption: 'Финансовые операции', icon: Building2, proposed: true,
    summary: 'Предложение для работы с финансовой частью отгрузок.',
    scope: 'Предлагается доступ к финансовым полям явно разрешённых компаний и их отгрузок с назначенными владельцами.',
    note: 'Роль пока недоступна для назначения. Состав финансовых полей и разрешения необходимо уточнить перед запуском.',
    permissions: [
      { label: 'Финансовые поля компаний', value: 'Предлагается просмотр назначенных', allowed: true },
      { label: 'Финансовые поля отгрузок', value: 'Предлагается просмотр в своей области', allowed: true },
      { label: 'Поля оплаты отгрузок', value: 'Предлагается изменение в своей области', allowed: true },
      { label: 'Финансовая выписка, отчёты и экспорт', value: 'Доступ не предусмотрен', allowed: false },
      { label: 'Импорт и управление доступом', value: 'Доступ не предусмотрен', allowed: false },
    ],
  },
  {
    id: 'warehouse', name: 'Сотрудник склада', caption: 'Логистика и статусы', icon: Warehouse, proposed: true,
    summary: 'Предложение для сопровождения назначенных отгрузок.',
    scope: 'Предлагается доступ к явно разрешённым отгрузкам и реквизитам доставки их покупателей. У отгрузки и покупателя должен быть владелец.',
    note: 'Роль пока недоступна для назначения. Перечень логистических полей и реквизитов доставки необходимо уточнить перед запуском.',
    permissions: [
      { label: 'Назначенные отгрузки', value: 'Предлагается просмотр логистических полей', allowed: true },
      { label: 'Реквизиты доставки покупателя', value: 'Предлагается ограниченный просмотр', allowed: true },
      { label: 'Статус, фактическая дата, примечание', value: 'Предлагается изменение в своей области', allowed: true },
      { label: 'Финансы, отчёты и экспорт', value: 'Доступ не предусмотрен', allowed: false },
      { label: 'Компании, импорт и управление ролями', value: 'Изменение не предусмотрено', allowed: false },
    ],
  },
];

export default function TeamPage({ managerLabels }: TeamPageProps) {
  const [selectedId, setSelectedId] = useState('director');
  const [activeUsers,setActiveUsers]=useState<number|null>(null);
  useEffect(()=>{fetch('/api/auth/users').then(async r=>{if(r.ok){const data=await r.json();setActiveUsers(data.users.filter((u:{active:boolean})=>u.active).length);}}).catch(()=>{});},[]);
  const [query, setQuery] = useState('');
  const [showAllLabels, setShowAllLabels] = useState(false);
  const selected = roles.find((role) => role.id === selectedId) ?? roles[0];
  const SelectedIcon = selected.icon;
  const filteredLabels = useMemo(() => managerLabels
    .filter((label) => label.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => b.shipmentCount - a.shipmentCount || a.name.localeCompare(b.name, 'ru')),
  [managerLabels, query]);
  const visibleLabels = showAllLabels ? filteredLabels : filteredLabels.slice(0, 6);

  return (
    <div className="team-page">
      <div className="team-stats">
        <div className="team-stat">
          <div className="team-stat-label"><UsersRound size={17} /> Действующие пользователи</div>
          <strong>{activeUsers??'—'} <span>пользователей</span></strong>
          <p>Активные учётные записи</p>
        </div>
        <div className="team-stat">
          <div className="team-stat-label"><ShieldCheck size={17} /> Роли в структуре</div>
          <strong>5 <span>ролей</span></strong>
          <p>3 действующие · 2 предложенные</p>
        </div>
        <div className="team-stat">
          <div className="team-stat-label"><Truck size={17} /> Распределение записей</div>
          <strong className="team-stat-text">По сотруднику</strong>
          <p>Связь учётной записи со справочником</p>
        </div>
      </div>

      <div className="team-access-layout">
        <section className="team-role-list" aria-labelledby="team-role-list-title">
          <div className="team-section-heading">
            <h3 id="team-role-list-title">Роли команды</h3>
            <span>05</span>
          </div>
          <div className="team-role-buttons" aria-label="Описание ролей">
            {roles.map((role) => {
              const Icon = role.icon;
              return (
                <button className={`team-role-button ${role.id === selectedId ? 'is-selected' : ''}`}
                  key={role.id} type="button" aria-pressed={role.id === selectedId}
                  onClick={() => setSelectedId(role.id)}>
                  <span className="team-role-icon"><Icon size={19} strokeWidth={1.7} /></span>
                  <span className="team-role-copy">
                    <span className="team-role-name">{role.name}</span>
                    <span className="team-role-caption">{role.proposed ? 'Предложенная роль' : role.caption}</span>
                  </span>
                  {role.id === selectedId && <ArrowRight className="team-role-arrow" size={16} />}
                </button>
              );
            })}
          </div>
          <div className="team-role-footnote"><Info size={15} /><span>Выберите роль, чтобы изучить её описание.</span></div>
        </section>

        <section className="team-role-detail" aria-live="polite" aria-labelledby="team-detail-title">
          <div className="team-detail-header">
            <div className="team-detail-title">
              <span className="team-detail-icon"><SelectedIcon size={24} strokeWidth={1.6} /></span>
              <div><h3 id="team-detail-title">{selected.name}</h3><p>{selected.summary}</p></div>
            </div>
            <span className={`team-badge ${selected.proposed ? 'is-proposed' : ''}`}>
              {selected.proposed ? <CircleDashed size={13} /> : <BadgeCheck size={13} />}
              {selected.proposed ? 'Предложено' : 'Описано'}
            </span>
          </div>
          <div className="team-scope">
            <LockKeyhole size={17} />
            <div><span>Область доступа</span><p>{selected.scope}</p></div>
          </div>
          <div className="team-permissions-heading">
            <h4>{selected.proposed ? 'Предлагаемые разрешения' : 'Разрешения по спецификации'}</h4>
            <span>{selected.proposed ? 'Сейчас активных прав нет' : 'Проверяются сервером'}</span>
          </div>
          <dl className="team-permissions">
            {selected.permissions.map((permission) => (
              <div className="team-permission" key={permission.label}>
                <dt>{permission.label}</dt>
                <dd>
                  <span className={`team-permission-icon ${!permission.allowed ? 'is-denied' : selected.proposed ? 'is-proposed' : ''}`}>
                    {!permission.allowed ? <X size={12} /> : selected.proposed ? <CircleDashed size={12} /> : <Check size={12} />}
                  </span>
                  {permission.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="team-detail-note"><Info size={15} /><p>{selected.note}</p></div>
        </section>
      </div>

      <section className="team-source-panel" aria-labelledby="team-source-title">
        <div className="team-source-header">
          <div className="team-source-title">
            <span className="team-source-icon"><FileSpreadsheet size={20} strokeWidth={1.6} /></span>
            <div><h3 id="team-source-title">Менеджеры из справочника</h3><p>Менеджеры и количество их отгрузок.</p></div>
          </div>
          <label className="team-search">
            <Search size={16} />
            <input aria-label="Поиск менеджера" placeholder="Найти менеджера" value={query}
              onChange={(event) => { setQuery(event.target.value); setShowAllLabels(false); }} />
          </label>
        </div>
        <div className="team-source-notice">Карточки менеджеров и назначения компаниям редактируются в справочнике.</div>
        <div className="team-source-table-wrap">
          <table className="team-source-table">
            <thead><tr><th scope="col">Менеджер</th><th scope="col">Отгрузок</th></tr></thead>
            <tbody>
              {visibleLabels.map((label, index) => (
                <tr key={`${label.name}-${index}`}>
                  <td><span className="team-source-mark"><FileSpreadsheet size={14} /></span>{label.name || 'Имя не указано'}</td>
                  <td>{label.shipmentCount.toLocaleString('ru-RU')}</td>
                </tr>
              ))}
              {visibleLabels.length === 0 && <tr><td colSpan={2} className="team-empty">{query ? 'Менеджеров по этому запросу не найдено' : 'Менеджеров пока нет'}</td></tr>}
            </tbody>
          </table>
        </div>
        {filteredLabels.length > 6 && (
          <button className="team-show-more" type="button" onClick={() => setShowAllLabels((value) => !value)}>
            {showAllLabels ? 'Свернуть список' : `Все менеджеры · ${filteredLabels.length}`}
            <ChevronDown size={15} className={showAllLabels ? 'is-open' : ''} />
          </button>
        )}
      </section>

      <p className="team-prototype-note"><LockKeyhole size={14} />Вход и права проверяются сервером. Директор и администратор управляют данными; менеджер работает с назначенными задачами и своими отгрузками.</p>
    </div>
  );
}
