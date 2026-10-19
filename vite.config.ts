import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import localApi from './server/local-api'
const directory = (path: string) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig(({ mode }) => {
  // Server-only configuration. No VITE_ key, client define, or browser-visible secret.
  const environment = loadEnv(mode, directory('.'), ['CHECKO_', 'ARTEL_', 'VAPID_', 'PUSH_', 'CRON_'])
  return {
  root: 'web',
  plugins: [react(), localApi({ bankEnvironment: environment, cabinetEnvironment: environment, checkoApiKey: environment.CHECKO_API_KEY, operationsDirectory: environment.ARTEL_STORE_DIR, cronSecret: environment.CRON_SECRET, pushConfig: { publicKey: environment.VAPID_PUBLIC_KEY ?? '', privateKey: environment.VAPID_PRIVATE_KEY ?? '', subject: environment.VAPID_SUBJECT ?? '', schedule: environment.PUSH_SCHEDULE_ENABLED === 'true' } })],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
    fs: { strict: true, allow: [directory('./web'), directory('./node_modules')], deny: ['**/data/**', '**/server/**', '**/qa/**', '**/.env*'] },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // The separate logistics frontend remains local; production publishes only CRM.
  // Shared form styles rely on the existing cascade across page stylesheets.
  build: { cssCodeSplit: false, outDir: '../app-dist', emptyOutDir: true, rollupOptions: {
    input: { crm: directory('./web/index.html') },
    output: { manualChunks(id) {
      if (id.includes('/node_modules/') && !id.includes('/ol/') && !id.includes('/rbush/') && !id.includes('/quickselect/')) return 'vendor'
      if (/\/web\/src\/(utils|auth-model|useDialogMotion|ScrollableSegments|page-access|page-catalog|push-client|workspace-api)\.tsx?$/.test(id)) return 'crm-shared'
    } },
  } },
  }
})
