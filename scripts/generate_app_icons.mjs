// Resize the approved master without changing its artwork. macOS ships sips.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'assets/artel-app-icon.png');
const destination = resolve(root, 'web/public/icons');
mkdirSync(destination, { recursive: true });
for (const [name, size] of [['favicon-32', 32], ['favicon-64', 64], ['apple-touch-icon', 180], ['icon-192', 192], ['icon-512', 512], ['icon-1024', 1024], ['icon-maskable-512', 512]]) {
  const output = resolve(destination, `${name}.png`);
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', output], { stdio: 'ignore' });
  console.log(`${name}.png: ${size} × ${size}`);
}
copyFileSync(resolve(destination, 'apple-touch-icon.png'), resolve(root, 'web/public/apple-touch-icon.png'));
