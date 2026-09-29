// Complete local pipeline: exact XML comparison -> preview/PDF -> PDF coverage.
// No application runtime, credentials, stores or Saby client are imported.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output');
if (outputAt < 0 || !args[outputAt + 1]) throw new Error('Provide --archive and --output PRIVATE_DIRECTORY');
const output = args[outputAt + 1];
const python = process.env.ETRN_PYTHON || 'python3';
const pdfPython = process.env.ETRN_PDF_PYTHON || python;
const run = (command, parameters) => spawnSync(command, parameters, { cwd: root, stdio: 'inherit' }).status ?? 2;
// Check dependency before replacing existing artifacts.
if (run(pdfPython, ['-c', 'import pypdf']) !== 0) {
  console.error('Set ETRN_PDF_PYTHON to a Python executable with pypdf (bundled desktop runtime is supported).');
  process.exit(2);
}
const comparison = run(python, ['scripts/replay_saby_etrn.py', ...args]);
if (comparison > 1) process.exit(comparison);
const rendered = run(process.execPath, ['scripts/render_etrn_replay.mjs', '--output', output]);
if (rendered) process.exit(rendered);
const checked = run(pdfPython, ['scripts/compare_etrn_pdfs.py', '--output', output]);
process.exit(checked || comparison);
