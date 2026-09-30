/** Shared field names keep editing, persistence and validation in sync. */
export const companyFields = [
  ['fullName','Полное наименование'],['kpp','КПП'],['ogrn','ОГРН / ОГРНИП'],['director','Генеральный директор'],['address','Юридический адрес'],
  ['phone','Телефон компании'],['email','Электронная почта'],['bankName','Банк клиента'],['settlementAccount','Расчётный счёт'],['correspondentAccount','Корреспондентский счёт'],['bik','БИК'],
] as const
export const driverFields = [
  ['inn','ИНН водителя'],['licenseSeries','Серия ВУ'],['licenseNumber','Номер ВУ'],['licenseIssuedAt','Дата выдачи ВУ'],
  ['fullName','ФИО по паспорту'],['passportIssuedBy','Кем выдан паспорт'],['passportIssuedAt','Дата выдачи паспорта'],['passportDepartmentCode','Код подразделения'],['passportSeries','Серия паспорта'],['passportNumber','Номер паспорта'],['gender','Пол'],['birthplace','Место рождения'],['birthdate','Дата рождения'],['registeredAddress','Адрес регистрации'],
] as const
export const vehicleFields = [
  ['vin','VIN'],['vehicleType','Тип транспортного средства'],['category','Категория ТС'],['manufactureYear','Год выпуска'],['engineModelNumber','Модель и номер двигателя'],['chassisNumber','Номер шасси / рамы'],['bodyNumber','Номер кузова / кабины'],['color','Цвет'],['enginePowerHp','Мощность, л. с.'],['enginePowerKw','Мощность, кВт'],['engineVolume','Рабочий объём двигателя, см³'],['engineType','Тип двигателя'],['environmentalClass','Экологический класс'],['maxWeight','Разрешённая максимальная масса, кг'],['unladenWeight','Масса без нагрузки, кг'],['manufacturer','Изготовитель'],['countryOfOrigin','Страна изготовления'],['ownerName','Собственник'],['ownerAddress','Адрес собственника'],
] as const
export const stsFields = [['stsSeries','Серия СТС'],['stsNumber','Номер СТС'],['stsIssuedAt','Дата выдачи СТС'],['stsIssuedBy','Кем выдано СТС'],['stsSpecialMarks','Особые отметки и дополнительные данные СТС']] as const
export const ptsFields = [['ptsSeries','Серия ПТС'],['ptsNumber','Номер ПТС / ЭПТС'],['ptsIssuedAt','Дата выдачи ПТС'],['ptsIssuedBy','Кем выдан ПТС'],['ptsCustomsDocument','Таможенный документ'],['ptsRestrictions','Таможенные ограничения'],['ptsSpecialMarks','Особые отметки и дополнительные данные ПТС']] as const
export const allVehicleFields = [...vehicleFields,...stsFields,...ptsFields] as const
/** Confirmed transport facts are separate from the vehicle's gross/unladen mass. */
export const vehicleTransportFields = [
  ['transportVehicleType','Тип ТС для транспортных документов'],['bodyType','Тип кузова'],['loadingMethod','Способ погрузки'],
  ['payloadTonnes','Подтверждённая грузоподъёмность, т'],['payloadSource','Источник грузоподъёмности (ПТС / СТС)'],
  ['ownershipType','Основание владения'],['leaseDocumentName','Наименование договора'],['leaseDocumentNumber','Номер договора'],['leaseDocumentDate','Дата договора'],['leaseDocumentIssuerInn','ИНН составителей договора'],
  ['cargoDistributable','Распределение груза по платформе'],
] as const
export const productTransportFields = [
  ['documentName','Полное наименование для документов'],['transportProductKind','Автоматизация транспортных документов'],['cargoPackaging','Способ перевозки груза'],
  ['dangerousGoodsUnNumber','Номер ООН'],['dangerousGoodsShippingName','Наименование опасного груза'],['dangerousGoodsClass','Класс опасности'],
  ['dangerousGoodsClassificationCode','Классификационный код'],['dangerousGoodsPackingGroup','Группа упаковки'],['dangerousGoodsHazardSign','Знаки опасности'],
  ['dangerousGoodsTunnelCode','Код ограничения проезда через тоннели'],['dangerousGoodsSource','Источник характеристик опасного груза'],
] as const
export type CompanyDetails = Partial<Record<(typeof companyFields)[number][0], string | null>>
export type DriverDetails = Partial<Record<(typeof driverFields)[number][0], string>>
export type VehicleDetails = Partial<Record<(typeof allVehicleFields)[number][0], string>>
export type VehicleTransportDetails = Partial<Record<Exclude<(typeof vehicleTransportFields)[number][0], 'cargoDistributable'>, string>> & { cargoDistributable?: '0' | '1' }
export type ProductTransportDetails = Partial<Record<Exclude<(typeof productTransportFields)[number][0], 'transportProductKind' | 'cargoPackaging'>, string>> & { transportProductKind?: 'diesel'; cargoPackaging?: 'bulk' | 'packaged' }
