/** Shared field names keep editing, persistence and validation in sync. */
export const companyFields = [
  ['fullName','Полное наименование'],['kpp','КПП'],['ogrn','ОГРН / ОГРНИП'],['director','Генеральный директор'],['address','Юридический адрес'],
  ['phone','Телефон компании'],['email','Электронная почта'],['bankName','Банк клиента'],['settlementAccount','Расчётный счёт'],['correspondentAccount','Корреспондентский счёт'],['bik','БИК'],
] as const
export const driverFields = [
  ['fullName','ФИО по паспорту'],['passportIssuedBy','Кем выдан паспорт'],['passportIssuedAt','Дата выдачи паспорта'],['passportDepartmentCode','Код подразделения'],['passportSeries','Серия паспорта'],['passportNumber','Номер паспорта'],['gender','Пол'],['birthplace','Место рождения'],['birthdate','Дата рождения'],['registeredAddress','Адрес регистрации'],
] as const
export const vehicleFields = [
  ['vin','VIN'],['vehicleType','Тип транспортного средства'],['category','Категория ТС'],['manufactureYear','Год выпуска'],['engineModelNumber','Модель и номер двигателя'],['chassisNumber','Номер шасси / рамы'],['bodyNumber','Номер кузова / кабины'],['color','Цвет'],['enginePowerHp','Мощность, л. с.'],['enginePowerKw','Мощность, кВт'],['engineVolume','Рабочий объём двигателя, см³'],['engineType','Тип двигателя'],['environmentalClass','Экологический класс'],['maxWeight','Разрешённая максимальная масса, кг'],['unladenWeight','Масса без нагрузки, кг'],['manufacturer','Изготовитель'],['countryOfOrigin','Страна изготовления'],['ownerName','Собственник'],['ownerAddress','Адрес собственника'],
] as const
export const stsFields = [['stsSeries','Серия СТС'],['stsNumber','Номер СТС'],['stsIssuedAt','Дата выдачи СТС'],['stsIssuedBy','Кем выдано СТС'],['stsSpecialMarks','Особые отметки и дополнительные данные СТС']] as const
export const ptsFields = [['ptsSeries','Серия ПТС'],['ptsNumber','Номер ПТС / ЭПТС'],['ptsIssuedAt','Дата выдачи ПТС'],['ptsIssuedBy','Кем выдан ПТС'],['ptsCustomsDocument','Таможенный документ'],['ptsRestrictions','Таможенные ограничения'],['ptsSpecialMarks','Особые отметки и дополнительные данные ПТС']] as const
export const allVehicleFields = [...vehicleFields,...stsFields,...ptsFields] as const
export type CompanyDetails = Partial<Record<(typeof companyFields)[number][0], string | null>>
export type DriverDetails = Partial<Record<(typeof driverFields)[number][0], string>>
export type VehicleDetails = Partial<Record<(typeof allVehicleFields)[number][0], string>>
