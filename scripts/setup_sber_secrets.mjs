// Local-only secret intake. Never prints submitted values or TLS exception text.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('.vercel/sber-private');
const pfxPath = process.argv[2];
if (!pfxPath) throw new Error('Pass the PKCS#12 file path as the only argument.');
const pfx = await readFile(pfxPath);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
let prior = {};
try { prior = JSON.parse(await readFile(resolve(directory, 'credentials.json'), 'utf8')); } catch {}
const csrf = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:8789';
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.headers.host !== '127.0.0.1:8789') { res.writeHead(403); return res.end(); }
  if (req.method === 'GET' && req.url === '/') return res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>СберБизнес — защищённая настройка</title><style>body{font:18px system-ui;max-width:620px;margin:70px auto;padding:24px;background:#f5f7f6;color:#163a2c}label{display:block;margin:28px 0 8px}input{display:block;width:95%;padding:14px;font:inherit}button{margin-top:28px;background:#176f4b;color:white;padding:15px 24px;border:0;border-radius:10px;font:inherit}</style><h1>Подключение СберБизнеса</h1><p>ООО «НК АРТЭЛЬ» · сервис 88091</p><p>Пароль сертификата уже сохранён, повторять его не нужно. Вставьте настройки из карточки Sber API. Форма работает только на этом компьютере. Значения сохраняются в закрытый локальный файл для последующей настройки сервера CRM и не выводятся в чат.</p><form method="post" action="/save" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="password">Пароль файла .p12</label><input id="password" name="password" type="password" ${prior.ARTEL_BANK_SBER_NK_TLS_PASSPHRASE ? '' : 'required'} autocomplete="off"><label for="settings">Настройки Sber API из кнопки «Скопировать настройки»</label><input id="settings" name="settings" type="password" autocomplete="off"><button>Проверить сертификат и сохранить</button></form></html>`);
  if (req.method !== 'POST' || req.url !== '/save' || req.headers.origin !== origin) { res.writeHead(403); return res.end(); }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 16384) { res.writeHead(413); return res.end(); } }
    const form = new URLSearchParams(body);
    if (form.get('csrf') !== csrf) { res.writeHead(403); return res.end(); }
    const passphrase = form.get('password') || prior.ARTEL_BANK_SBER_NK_TLS_PASSPHRASE;
    if (!passphrase) throw new Error();
    createSecureContext({ pfx, passphrase, minVersion: 'TLSv1.2' });
    const settings = { ...prior, ARTEL_BANK_SBER_NK_CLIENT_ID: '88091', ARTEL_BANK_SBER_NK_TLS_PFX_BASE64: pfx.toString('base64'), ARTEL_BANK_SBER_NK_TLS_PASSPHRASE: passphrase };
    if (form.get('settings')) await writeFile(resolve(directory, 'copied-settings.txt'), form.get('settings'), { mode: 0o600 });
    await writeFile(resolve(directory, 'credentials.json'), JSON.stringify(settings), { mode: 0o600 });
    await chmod(resolve(directory, 'credentials.json'), 0o600);
    res.end('<meta charset="utf-8"><h1>Сертификат проверен. Настройки сохранены.</h1><p>Можно вернуться в Codex. Пароли отправлять в чат не нужно.</p>');
    console.log('Certificate validated; private settings saved.');
    server.close();
  } catch { res.writeHead(400); res.end('<meta charset="utf-8"><h1>Не удалось открыть сертификат</h1><p>Проверьте пароль или совместимость контейнера. <a href="/">Вернуться к вводу</a></p>'); }
});
server.listen(8789, '127.0.0.1', () => console.log('Secret intake available at http://127.0.0.1:8789'));
