import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from './api-error';

type PasswordRecord = { salt: string; passwordHash: string; passwordCiphertext?: string };
const aad = (record: PasswordRecord) => Buffer.from(`artel-account-password-v1:${record.salt}:${record.passwordHash}`);
function key(value: string | undefined) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new ApiError(503, 'Хранилище паролей недоступно. Обратитесь к администратору.');
  return Buffer.from(value, 'hex');
}
export function encryptAccountPassword(password: string, record: PasswordRecord, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(aad(record));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join('.');
}
export function validPasswordCiphertext(value: unknown): value is string {
  return typeof value === 'string' && /^v1\.[a-f0-9]{24}\.[a-f0-9]{32}\.(?:[a-f0-9]{2}){12,1024}$/.test(value);
}
export function decryptAccountPassword(record: PasswordRecord, secret: string | undefined) {
  if (!record.passwordCiphertext) throw new ApiError(409, 'Пароль задан до включения просмотра и недоступен. Он остаётся действующим.');
  const encryptionKey = key(secret);
  try {
    if (!validPasswordCiphertext(record.passwordCiphertext)) throw new Error('Invalid envelope');
    const [, iv, tag, encrypted] = record.passwordCiphertext.split('.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'hex'));
    decipher.setAAD(aad(record)); decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
  } catch { throw new ApiError(409, 'Не удалось прочитать сохранённый пароль.'); }
}
