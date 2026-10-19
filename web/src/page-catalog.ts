// Page visibility is shared by navigation and account access controls.
// Disabled pages stay in the permission schema to preserve historical grants.
export const pageCatalog = [
  {id:'overview',title:'Обзор',icon:'LayoutDashboard',section:0,description:'',enabled:true},
  {id:'work',title:'Работа',icon:'ClipboardList',section:0,description:'Задачи, календарь и работа с компаниями.',enabled:true},
  {id:'shipments',title:'Отгрузки',icon:'Truck',section:0,description:'Движение топлива — от поставщика до покупателя.',enabled:true},
  {id:'trips',title:'Рейсы',icon:'Route',section:0,description:'Маршруты, клиентские доставки и отправка в Saby.',enabled:true},
  {id:'payments',title:'Платежи',icon:'Wallet',section:0,description:'Поступления и списания из банковской выписки.',enabled:true},
  {id:'cabinet-balances',title:'Балансы кабинетов',icon:'Landmark',section:0,description:'Остатки в личных кабинетах.',enabled:true},
  {id:'stock',title:'Склад',icon:'PackageCheck',section:0,description:'',enabled:false},
  {id:'china',title:'Китай',icon:'Globe',section:0,description:'',enabled:true},
  {id:'operator',title:'Операторская',icon:'Headphones',section:0,description:'Заправки, ручное подтверждение оплаты и реквизиты получателей.',enabled:true},
  {id:'payroll',title:'ЗП',icon:'Banknote',section:1,description:'',enabled:false},
  {id:'accounts',title:'Сотрудники и доступ',icon:'UsersRound',section:1,description:'Учётные записи и права сотрудников.',enabled:true},
  {id:'directories',title:'Справочники',icon:'BookOpen',section:1,description:'Клиенты, поставщики, нефтебазы, водители и автомобили.',enabled:true},
] as const;
export type PageId = typeof pageCatalog[number]['id'];
export const enabledPages = pageCatalog.filter(page => page.enabled);
export const permissionSections = pageCatalog;
