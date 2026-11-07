export type OperatorServiceTone = 'lukoil' | 'yandex' | 'rosneft' | 'gpn' | 'nnk' | 'neutral'

const normalizeService = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '')
const serviceAliases: Record<Exclude<OperatorServiceTone, 'neutral'>, readonly string[]> = {
  lukoil: ['лукойл', 'лукоил', 'lukoil', 'lukoyl', 'licard'],
  yandex: ['яндекс', 'яндексgo', 'яндексго', 'яндексзаправки', 'yandex', 'yandexgo'],
  rosneft: ['роснефть', 'rosneft'],
  gpn: ['гпн', 'газпромнефть', 'gpn', 'gazpromneft'],
  nnk: ['ннк', 'nnk', 'независимаянефтегазоваякомпания'],
}

/** Existing colors remain the default until an explicit background is saved. */
export function operatorServiceTone(service: string, serviceId?: string): OperatorServiceTone {
  const name = normalizeService(service)
  for (const [tone, aliases] of Object.entries(serviceAliases)) {
    if (aliases.includes(name)) return tone as OperatorServiceTone
  }
  const id = normalizeService(serviceId ?? '').replace(/^operatorservice/, '')
  for (const [tone, aliases] of Object.entries(serviceAliases)) {
    if (aliases.includes(id)) return tone as OperatorServiceTone
  }
  return 'neutral'
}

export const operatorServiceColors = ['#fcebed', '#fff1ae', '#30363d', '#eaf2ff', '#e3f3e9', '#edf1ee'] as const;
export function operatorServiceBackground(name: string, id?: string) {
  return ({ lukoil:'#fcebed', yandex:'#fff1ae', rosneft:'#30363d', gpn:'#eaf2ff', nnk:'#e3f3e9', neutral:'#edf1ee' })[operatorServiceTone(name, id)];
}
export function operatorServiceInk(background: string) {
  const channels = background.slice(1).match(/../g)!.map(hex => parseInt(hex,16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luminance = .2126*channels[0] + .7152*channels[1] + .0722*channels[2];
  return (luminance+.05)/.05 >= 1.05/(luminance+.05) ? '#000000' : '#ffffff';
}
