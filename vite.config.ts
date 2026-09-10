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
  plugins: [react(), localApi({ checkoApiKey: environment.CHECKO_API_KEY, operationsDirectory: environment.ARTEL_STORE_DIR, cronSecret: environment.CRON_SECRET, pushConfig: { publicKey: environment.VAPID_PUBLIC_KEY ?? '', privateKey: environment.VAPID_PRIVATE_KEY ?? '', subject: environment.VAPID_SUBJECT ?? '', schedule: environment.PUSH_SCHEDULE_ENABLED === 'true' } })],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
    fs: { strict: true, allow: [directory('./web'), directory('./node_modules')], deny: ['**/data/**', '**/server/**', '**/qa/**', '**/.env*'] },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: '../app-dist', emptyOutDir: true },
  }
})
