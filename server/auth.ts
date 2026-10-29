import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { AccountUser } from '../web/src/auth-model';
import { effectiveSections, defaultEmployeeSections, validDirectoryGrants, hasSection, isAdministrator, isScopedEmployee, sections, type SectionId } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { queueInvoiceRevocations } from './invoice-bridge';

import { encryptAccountPassword, validPasswordCiphertext } from './account-passwords';

const scrypt = promisify(derive);
export interface StoredUser extends AccountUser { passwordHash: string; salt: string; passwordCiphertext?: string; deletedBy?: string }
export interface AccountsData {
  users: StoredUser[];
  sessions: { hash: string; userId: string; expiresAt: number; audience?: 'logistics' }[];
  attempts: Record<string, { count: number; until: number }>;
}
export const publicUser = (user: StoredUser): AccountUser => ({ id:user.id, name:user.name, login:user.login, role:user.role, managerId:user.managerId, ...(user.driverId ? { driverId: user.driverId } : {}), active:user.active, version:user.version, sections:effectiveSections(user), ...(user.directoryGrants ? { directoryGrants: [...user.directoryGrants] } : {}), ...(user.deletedAt ? { deletedAt: user.deletedAt } : {}) });
export const activeUsers = (data: OperationsData) => (data.accounts?.users ?? []).filter(user=>user.active && !user.deletedAt && user.role !== 'driver').map(publicUser);
export const canManage = isAdministrator;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const cookieName = 'artel_session';
export const logisticsCookieName = 'artel_logistics_session';
export const logisticsRequest = (request: Pick<IncomingMessage, 'url'>) => request.url?.split('?')[0].startsWith('/api/logistics/') === true;
export function sessionToken(request: IncomingMessage) {
  const name = logisticsRequest(request) ? logisticsCookieName : cookieName;
  const token = request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

/** Driver identity must still exist in the live directory on every session use. */
export function driverAccountAvailable(data: OperationsData, user: AccountUser) {
  if (user.role !== 'driver') return true;
  const entry = data.directories?.drivers.find(row => row.id === user.driverId);
  const flags = entry as (typeof entry & { archived?: boolean; directoryArchived?: boolean; deletedAt?: string }) | undefined;
  return !!entry && !flags?.archived && !flags?.directoryArchived && !flags?.deletedAt && !data.directories?.deletedEntries?.drivers?.includes(entry.id);
}
export function authenticate(data: OperationsData, request: IncomingMessage): AccountUser | null {
  const token = sessionToken(request);
  const audience = logisticsRequest(request) ? 'logistics' : undefined;
  const session = token && data.accounts?.sessions.find(row=>row.hash===hash(token) && row.expiresAt>Date.now() && row.audience === audience);
  const user = session && data.accounts?.users.find(row=>row.id===session.userId && row.active && !row.deletedAt);
  return user && driverAccountAvailable(data, user) && (!audience || user.role === 'driver' || hasSection(user, 'trips')) ? publicUser(user) : null;
}
export function sessionCookie(token: string, secure: boolean, audience?: 'logistics') { return `${audience ? logisticsCookieName : cookieName}=${token}; Path=${audience ? '/api/logistics' : '/'}; HttpOnly; SameSite=Strict; Max-Age=${token?28800:0}${secure?'; Secure':''}`; }
export function requireUser(data: OperationsData, request: IncomingMessage) { const user=authenticate(data,request); if(!user)throw new ApiError(401,'Войдите в приложение.');return user; }
export function requireAccounts(user: AccountUser) { if (!hasSection(user, 'accounts')) throw new ApiError(403, 'Раздел недоступен. Обратитесь к администратору.'); }
export function requireManage(user: AccountUser) { if(!canManage(user))throw new ApiError(403,'Действие доступно директору и администратору.'); }
export function validateAccounts(value: AccountsData) {
  if(!value || !Array.isArray(value.users) || !Array.isArray(value.sessions) || !value.attempts || typeof value.attempts!=='object')throw new Error('Invalid accounts');
  const ids=new Set<string>(), logins=new Set<string>(), driverIds=new Set<string>();
  for(const u of value.users){
    if (u.passwordCiphertext !== undefined && !validPasswordCiphertext(u.passwordCiphertext)) throw new Error('Invalid password ciphertext');
    if (u.deletedAt !== undefined && (typeof u.deletedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(u.deletedAt) || !Number.isFinite(Date.parse(u.deletedAt)) || new Date(u.deletedAt).toISOString() !== u.deletedAt || u.active || typeof u.deletedBy !== 'string' || !u.deletedBy) || u.deletedBy !== undefined && u.deletedAt === undefined) throw new Error('Invalid user deletion');
    if (u.directoryGrants !== undefined && !validDirectoryGrants(u.directoryGrants)) throw new Error('Invalid directory grants');
    if (u.sections !== undefined && (!Array.isArray(u.sections) || new Set(u.sections).size !== u.sections.length || u.sections.some(id => id !== 'settlements' && !sections.some(section => section.id === id)))) throw new Error('Invalid sections');
    if(!u || typeof u.id!=='string' || !u.id || ids.has(u.id) || typeof u.name!=='string' || !u.name || typeof u.login!=='string' || !/^[a-z0-9._-]{3,64}$/.test(u.login) || logins.has(u.login) || !['director','admin','employee','manager','logistician','driver'].includes(u.role) || (u.managerId!==null && typeof u.managerId!=='string') || typeof u.active!=='boolean' || !Number.isSafeInteger(u.version) || u.version<1 || !/^[a-f0-9]{128}$/.test(u.passwordHash) || !/^[a-f0-9]{32}$/.test(u.salt))throw new Error('Invalid user');
    if (u.role === 'driver') {
      if (typeof u.driverId !== 'string' || !u.driverId || driverIds.has(u.driverId) || u.managerId !== null || !Array.isArray(u.sections) || u.sections.length) throw new Error('Invalid driver account');
      driverIds.add(u.driverId);
    } else if (u.driverId !== undefined) throw new Error('Invalid employee driver binding');
    ids.add(u.id);logins.add(u.login);
  }
  if(value.users.length && !value.users.some(u=>u.active && u.role==='director'))throw new Error('Director required');
  for(const row of value.sessions)if(!row || !ids.has(row.userId) || !/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.expiresAt) || row.audience !== undefined && row.audience !== 'logistics')throw new Error('Invalid session');
  for(const [key,row] of Object.entries(value.attempts))if(!/^[a-f0-9]{64}$/.test(key) || !row || !Number.isSafeInteger(row.count) || row.count<0 || !Number.isSafeInteger(row.until))throw new Error('Invalid login attempt');
}
function text(input: Record<string,unknown>, key:string, max=120) { const v=input[key];if(typeof v!=='string' || !v.trim() || v.trim().length>max)throw new ApiError(400,`Проверьте поле «${key}».`);return v.trim(); }
export async function passwordFields(input: unknown, passwordKey = process.env.ARTEL_ACCOUNT_PASSWORD_KEY) {
  if(typeof input!=='string' || input.length<12 || input.length>256)throw new ApiError(400,'Пароль должен содержать от 12 до 256 символов.');
  const salt=randomBytes(16).toString('hex');
  const fields = { salt, passwordHash: (await scrypt(input,salt,64) as Buffer).toString('hex') };
  return { ...fields, passwordCiphertext: passwordKey === undefined ? undefined : encryptAccountPassword(input, fields, passwordKey) };
}
export async function saveUser(data:OperationsData,snapshot:Snapshot,input:Record<string,unknown>,id?:string,setup=false,passwordKey = process.env.ARTEL_ACCOUNT_PASSWORD_KEY) {
  if(Object.keys(input).some(k=>!['name','login','password','role','managerId','active','version','setupToken','sections','directoryGrants'].includes(k)))throw new ApiError(400,'Неизвестное поле пользователя.');
  const accounts=data.accounts ??= {users:[],sessions:[],attempts:{}};
  const previous=id?accounts.users.find(u=>u.id===id):undefined;
  if (previous?.role === 'driver') throw new ApiError(403, 'Управляйте доступом водителя в разделе «Сотрудники и доступ».');
  if(id && (!previous || previous.deletedAt))throw new ApiError(404,'Пользователь не найден.');
  if(previous && input.version!==previous.version)throw new ApiError(409,'Пользователь уже изменён. Обновите список.');
  const name=text(input,'name'),login=text(input,'login',64).toLowerCase();
  if(!/^[a-z0-9._-]{3,64}$/.test(login))throw new ApiError(400,'Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание.');
  if(accounts.users.some(u=>u.login===login && u.id!==id))throw new ApiError(409,'Этот логин уже используется.');
  const role=setup?'director':input.role;
  if(!['director','admin','employee','manager','logistician'].includes(String(role)))throw new ApiError(400,'Выберите роль пользователя.');
  const managerId=input.managerId || null;
  if(managerId!==null && (typeof managerId!=='string' || !snapshot.directories?.managers.some(m=>m.id===managerId)))throw new ApiError(400,'Выберите сотрудника из справочника.');
  if(managerId && accounts.users.some(u=>u.id!==id && u.managerId===managerId && u.active))throw new ApiError(409,'Сотрудник уже связан с активной учётной записью.');
  if(input.active!==undefined && typeof input.active!=='boolean')throw new ApiError(400,'Некорректный статус пользователя.');
  const active=setup?true:input.active!==false;
  if(previous?.role==='director' && (!active || role!=='director') && !accounts.users.some(u=>u.id!==id && u.active && u.role==='director'))throw new ApiError(409,'Нельзя отключить последнего директора.');
  if (!setup && !managerId && (!previous || isScopedEmployee({ role: role as AccountUser['role'] }) && active)) throw new ApiError(400, 'Свяжите учётную запись с сотрудником справочника.');
  if (input.sections !== undefined && (!Array.isArray(input.sections) || new Set(input.sections).size !== input.sections.length || input.sections.some(id => id !== 'settlements' && !sections.some(section => section.id === id)))) throw new ApiError(400, 'Некорректный список разделов.');
  if (input.directoryGrants !== undefined && !validDirectoryGrants(input.directoryGrants)) throw new ApiError(400, 'Некорректный список справочников.');
  const permissions = input.sections === undefined ? previous && isScopedEmployee(previous) ? effectiveSections(previous) : undefined
    : [...new Set((input.sections as SectionId[]).map(id => id === 'settlements' ? 'overview' : id))];
  if (previous?.passwordCiphertext && input.password && !passwordKey) throw new ApiError(503, 'Хранилище паролей недоступно.');
  const user:StoredUser={...(previous??await passwordFields(input.password, passwordKey)),...(previous && input.password?await passwordFields(input.password, passwordKey):{}),id:id??`user-${randomUUID()}`,name,login,role:role as AccountUser['role'],managerId:managerId as string|null,active,version:(previous?.version??0)+1};
  user.sections = isScopedEmployee(user) ? [...(permissions ?? (previous ? [] : defaultEmployeeSections))]
    : sections.map(section => section.id);
  if (previous && hasSection(previous, 'invoices')) queueInvoiceRevocations(data, accounts.sessions.filter(session => session.userId === id && !session.audience).map(session => session.hash));
  if (isScopedEmployee(user)) {
    if (input.directoryGrants !== undefined) user.directoryGrants = [...input.directoryGrants as NonNullable<AccountUser['directoryGrants']>];
    else if (previous && !isScopedEmployee(previous)) delete user.directoryGrants;
  } else delete user.directoryGrants;
  if(previous)accounts.users[accounts.users.indexOf(previous)]=user;else accounts.users.push(user);
  if(previous)accounts.sessions=accounts.sessions.filter(s=>s.userId!==id);
  if (previous && data.push) data.push.devices = data.push.devices.filter(device => device.userId !== id);
  return publicUser(user);
}
/** Keep the identity for historical authors and assignments; access is revoked atomically. */
export function deleteUser(data: OperationsData, actor: AccountUser, id: string, input: Record<string, unknown>) {
  requireAccounts(actor);
  if (Object.keys(input).some(key => !['version', 'confirmationName'].includes(key))) throw new ApiError(400, 'Неизвестное поле удаления пользователя.');
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) throw new ApiError(400, 'Передайте версию пользователя.');
  const accounts = data.accounts;
  const user = accounts?.users.find(row => row.id === id);
  if (!accounts || !user) throw new ApiError(404, 'Пользователь не найден.');
  if (user.role === 'driver') throw new ApiError(403, 'Управляйте доступом водителя в разделе «Сотрудники и доступ».');
  if (input.confirmationName !== user.name) throw new ApiError(400, 'Для подтверждения введите точное имя сотрудника.');
  if (actor.id === id) throw new ApiError(409, 'Нельзя удалить свою учётную запись.');
  // The same DELETE can be safely retried after a lost response, without another revision.
  if (user.deletedAt && (input.version === user.version - 1 || input.version === user.version)) return { id, deleted: true, changed: false };
  if (input.version !== user.version) throw new ApiError(409, 'Пользователь уже изменён. Обновите список.');
  if (user.active && user.role === 'director' && !accounts.users.some(row => row.id !== id && row.active && !row.deletedAt && row.role === 'director')) throw new ApiError(409, 'Нельзя удалить последнего активного директора.');
  const tasks = data.work?.tasks.filter(row => row.assigneeId === id && !row.archivedAt && row.status !== 'done').length ?? 0;
  const companies = data.work?.companyRecords.filter(row => row.assigneeId === id && !row.archivedAt).length ?? 0;
  if (tasks || companies) throw new ApiError(409, `У сотрудника есть незавершённые записи: задачи — ${tasks}, работа с компаниями — ${companies}. В разделе «Работа» передайте их другому сотруднику или завершите и архивируйте, затем повторите удаление.`);
  if (hasSection(user, 'invoices')) queueInvoiceRevocations(data, accounts.sessions.filter(session => session.userId === id && !session.audience).map(session => session.hash));
  user.active = false;
  user.deletedAt = new Date().toISOString();
  user.deletedBy = actor.id;
  user.version += 1;
  accounts.sessions = accounts.sessions.filter(session => session.userId !== id);
  if (data.push) {
    const deviceIds = new Set(data.push.devices.filter(device => device.userId === id).map(device => device.id));
    data.push.devices = data.push.devices.filter(device => device.userId !== id);
    for (const [key, delivery] of Object.entries(data.push.deliveries)) if (deviceIds.has(delivery.deviceId)) delete data.push.deliveries[key];
    for (const [key, probe] of Object.entries(data.push.probes ?? {})) if (probe.userId === id) delete data.push.probes![key];
    for (const [key, assignment] of Object.entries(data.push.taskAssignments ?? {})) if (assignment.assigneeId === id) delete data.push.taskAssignments![key];
  }
  return { id, deleted: true, changed: true };
}
interface LoginResult { status: number; token?: string; user?: AccountUser; error?: string }
const loginName = (input: Record<string, unknown>) => typeof input.login === 'string' ? input.login.trim().toLowerCase().slice(0, 64) : '';
const loginIdentity = (user: StoredUser | undefined): string | null => user ? JSON.stringify([
  user.id, user.login, user.passwordHash, user.salt, user.version, user.active, user.deletedAt,
  user.role, user.managerId, user.driverId, user.sections, user.directoryGrants,
]) : null;

/** Credential work has no authority to create a session. The returned completion
 * is scoped to one mutate call and must recheck fresh transaction identity,
 * throttles, audience and driver availability before publishing a session. */
export async function prepareLogin(data: OperationsData, input: Record<string, unknown>, audience?: 'logistics') {
  if (!data.accounts?.users.length) throw new ApiError(403, 'Сначала создайте учётную запись директора.');
  const name = loginName(input);
  const user = data.accounts.users.find(row => row.login === name && row.active && !row.deletedAt);
  // Capture primitives before yielding, even if a caller mutates its input object.
  const identity = loginIdentity(user), expected = user?.passwordHash;
  const salt = user?.salt ?? '00000000000000000000000000000000';
  const password = typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
  // Known, unknown and throttled users all perform the same password derivation.
  const actual = await scrypt(password, salt, 64) as Buffer;
  const verified = expected !== undefined && timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  return (fresh: OperationsData, onChanged: () => void = () => {}): LoginResult => {
    return finishLogin(fresh, name, identity, verified, audience, onChanged);
  };
}

/** Atomic setup and direct callers retain the same public helper. HTTP login
 * prepares outside mutate and invokes only its synchronous completion inside. */
export async function login(data: OperationsData, input: Record<string, unknown>, audience?: 'logistics', onChanged: () => void = () => {}) {
  return (await prepareLogin(data, input, audience))(data, onChanged);
}

function finishLogin(data:OperationsData,name:string,identity:string|null,verified:boolean,audience:'logistics'|undefined,onChanged:()=>void):LoginResult {
  const accounts=data.accounts;
  if(!accounts?.users.length)throw new ApiError(403,'Сначала создайте учётную запись директора.');
  const now=Date.now(), key=hash(`artel:auth:user:${name}`), globalKey=hash('artel:auth:global-login-limit:v2');
  for(const [k,a] of Object.entries(accounts.attempts))if(a.until<=now){delete accounts.attempts[k];onChanged();}
  // Preserve existing throttles when separating user keys from the old global
  // sentinel, which was also a legal account login. No password or session changes.
  const migrateAttempt = (oldKey: string, newKey: string, limit: number, remove = true) => {
    const old = accounts.attempts[oldKey];
    if (!old) return;
    const current = accounts.attempts[newKey];
    accounts.attempts[newKey] = { count: Math.min(limit, Math.max(old.count, current?.count ?? 0)), until: Math.max(old.until, current?.until ?? 0) };
    if (remove) delete accounts.attempts[oldKey];
    onChanged();
  };
  const legacyGlobalKey=hash('artel-global-login-limit');
  migrateAttempt(legacyGlobalKey,globalKey,50,false);
  for(const account of accounts.users)migrateAttempt(hash(account.login),hash(`artel:auth:user:${account.login}`),5,hash(account.login)!==legacyGlobalKey);
  if(accounts.attempts[legacyGlobalKey]){delete accounts.attempts[legacyGlobalKey];onChanged();}
  if(/^[a-z0-9._-]{3,64}$/.test(name))migrateAttempt(hash(name),key,5);
  const limited = {error:'Слишком много попыток. Повторите через 15 минут.',status:429};
  const userLimited=(accounts.attempts[key]?.count??0)>=5;
  const globalLimited=(accounts.attempts[globalKey]?.count??0)>=50;
  const user=accounts.users.find(u=>u.login===name && u.active && !u.deletedAt);
  if(userLimited)return limited;
  if(!user || loginIdentity(user)!==identity || !verified || !driverAccountAvailable(data, user)){
    if(!globalLimited || user){
      for(const k of [key,globalKey])accounts.attempts[k]={count:Math.min((accounts.attempts[k]?.count??0)+1,k===globalKey?50:5),until:accounts.attempts[k]?.until??now+900000};
      onChanged();
    }
    return globalLimited?limited:{error:'Неверный логин или пароль.',status:401};
  }
  if(accounts.attempts[key]){delete accounts.attempts[key];onChanged();}
  if (audience && user.role !== 'driver' && !hasSection(user, 'trips')) return { error: 'Раздел рейсов недоступен. Обратитесь к администратору.', status: 403 };
  const token=randomBytes(32).toString('hex');
  accounts.sessions=accounts.sessions.filter(s=>s.expiresAt>now).slice(-499);
  accounts.sessions.push({hash:hash(token),userId:user.id,expiresAt:now+28800000,...(audience ? { audience } : {})});
  onChanged();
  return {token,user:publicUser(user),status:200};
}
export function logout(data:OperationsData,request:IncomingMessage){
  const token=sessionToken(request);
  if(data.accounts && token) {
    const session = data.accounts.sessions.find(row => row.hash === hash(token));
    const user = session && data.accounts.users.find(row => row.id === session.userId);
    if (session && !session.audience && user && hasSection(user, 'invoices')) queueInvoiceRevocations(data, [session.hash]);
    data.accounts.sessions=data.accounts.sessions.filter(s=>s.hash!==hash(token));
  }
}
