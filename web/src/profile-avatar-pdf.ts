import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export async function renderAvatarPdf(data: ArrayBuffer, size: number): Promise<HTMLCanvasElement> {
  const loading = getDocument({
    data,
    disableWorkerRendering: true,
    useWasm: false,
    maxImageSize: 16_000_000,
  })
  const timeout = setTimeout(() => { void loading.destroy().catch(() => {}) }, 10_000)
  try {
    const document = await loading.promise
    const page = await document.getPage(1)
    const natural = page.getViewport({ scale: 1 })
    const edge = Math.max(natural.width, natural.height)
    if (!Number.isFinite(edge) || edge <= 0) throw new Error('Invalid page dimensions')
    const viewport = page.getViewport({ scale: size / edge })
    const canvas = window.document.createElement('canvas')
    canvas.width = canvas.height = size
    await page.render({
      canvas,
      viewport,
      transform: [1, 0, 0, 1, (size - viewport.width) / 2, (size - viewport.height) / 2],
      background: '#fff',
      annotationMode: AnnotationMode.DISABLE,
    }).promise
    return canvas
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'PasswordException') throw new Error('Выберите PDF без пароля.', { cause: reason })
    throw new Error('Не удалось открыть PDF. Выберите другой файл.', { cause: reason })
  } finally {
    clearTimeout(timeout)
    if (!loading.destroyed) await loading.destroy().catch(() => {})
  }
}
