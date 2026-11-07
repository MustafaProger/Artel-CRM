import { build } from 'esbuild';

await build({
  entryPoints: ['server/production.ts'],
  outfile: 'server-render/production.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  // Bundled CommonJS dependencies can still load Node built-ins in the ESM entrypoint.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

await build({
  entryPoints: ['scripts/grant-invoice-access.ts'],
  outfile: 'server-render/grant-invoice-access.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
