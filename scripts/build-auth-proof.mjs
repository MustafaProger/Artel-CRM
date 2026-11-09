// Build portable, synthetic-only Linux crash proofs from the exact source.
// These are mounted as release helpers, never included in the runtime image.
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output = resolve(process.argv[2] || '../helpers');
await mkdir(output, { recursive: true });
for (const [entry, name] of [['scripts/profile-auth-crash.mjs', 'auth-crash-child.mjs'], ['tests/auth-partition-crash.test.ts', 'auth-partition-crash.test.mjs'], ['scripts/profile-auth-archive-crash.mjs', 'auth-archive-crash-child.mjs'], ['tests/auth-archive-crash.test.ts', 'auth-archive-crash.test.mjs'], ['scripts/auth-large-copy-proof.ts', 'auth-large-copy-proof.mjs']]) {
  await build({ entryPoints: [entry], outfile: resolve(output, name), bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
}
for (const name of ['auth-partition-image-smoke.mjs', 'auth-partition-image-fixture.json']) await copyFile(resolve('scripts', name), resolve(output, name));
