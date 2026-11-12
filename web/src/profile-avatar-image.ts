const fileLimit = 10 * 1024 * 1024
const avatarSize = 256
const jpegPrefix = 'data:image/jpeg;base64,'

export async function prepareAvatarImage(file: File): Promise<string> {
  if (file.size > fileLimit) throw new Error('Выберите файл размером до 10 МБ.')
  const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer())
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => header[index] === byte)
  const webp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP'

  let canvas: HTMLCanvasElement
  if (jpeg || png || webp) {
    canvas = await cropImage(file)
  } else if (String.fromCharCode(...header).includes('%PDF-')) {
    const { renderAvatarPdf } = await import('./profile-avatar-pdf')
    canvas = await renderAvatarPdf(await file.arrayBuffer(), avatarSize)
  } else {
    throw new Error('Выберите файл JPG, PNG, WebP или PDF.')
  }

  for (const quality of [0.86, 0.72, 0.55]) {
    const jpegUrl = canvas.toDataURL('image/jpeg', quality)
    const padding = jpegUrl.endsWith('==') ? 2 : jpegUrl.endsWith('=') ? 1 : 0
    if (jpegUrl.startsWith(jpegPrefix) && (jpegUrl.length - jpegPrefix.length) * 3 / 4 - padding <= 64 * 1024) return jpegUrl
  }
  throw new Error('Не удалось уменьшить аватар. Выберите другой файл.')
}

async function cropImage(file: File): Promise<HTMLCanvasElement> {
  const image = new Image()
  const url = URL.createObjectURL(file)
  try {
    image.src = url
    await image.decode().catch(() => { throw new Error('Не удалось открыть фото. Выберите другое изображение.') })
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    if (!side) throw new Error('Не удалось открыть фото. Выберите другое изображение.')

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = Math.min(side, avatarSize)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Не удалось подготовить фото.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}
