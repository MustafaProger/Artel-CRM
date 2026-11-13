import { performanceSpan } from './performance-trace';
import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { AccountUser } from '../web/src/auth-model';
import { isClosedWorkStatus, workAssigneeIds } from '../web/src/work-model';
import { effectiveSections, defaultEmployeeSections, validDirectoryGrants, hasSection, isAdministrator, isDeveloper, isScopedEmployee, roleNames, sections, type SectionId } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { queueInvoiceRevocations } from './invoice-bridge';

import { encryptAccountPassword, validPasswordCiphertext } from './account-passwords';
import { parseProfileAvatar, profileAvatarProjection, sameAvatar, validStoredAvatar, type StoredAvatar } from './profile-avatars';

const scrypt = promisify(derive);
export interface StoredUser extends AccountUser { passwordHash: string; salt: string; passwordCiphertext?: string; deletedBy?: string; avatar?: StoredAvatar }
export interface AccountsData {
  users: StoredUser[];
  sessions: { hash: string; userId: string; expiresAt: number; audience?: 'logistics' }[];
  attempts: Record<string, { count: number; until: number }>;
}
export const publicUser = (user: StoredUser): AccountUser => ({ id:user.id, name:user.name, login:user.login, role:user.role === 'logistician' ? 'employee' : user.role, managerId:user.managerId, ...(user.driverId ? { driverId: user.driverId } : {}), active:user.active, version:user.version, sections:effectiveSections(user), ...(user.customSections ? { customSections: true } : {}), ...profileAvatarProjection(user.id, user.avatar), ...(user.directoryGrants ? { directoryGrants: [...user.directoryGrants] } : {}), ...(user.deletedAt ? { deletedAt: user.deletedAt } : {}) });
export const activeUsers = (data: OperationsData) => (data.accounts?.users ?? []).filter(user=>user.active && !user.deletedAt && user.role !== 'driver').map(publicUser);
export const canManage = isAdministrator;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const accountLoginPattern = /^[a-z0-9._-]{3,64}$/;
const normalizeAccountLogin = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const loginAttemptKey = (login: string) => hash(`artel:auth:user:${login}`);
const legacyGlobalLoginKey = hash('artel-global-login-limit');
// Keep the existing integer field so live sessions and push bindings need no storage migration.
export const persistentSessionExpiry = Number.MAX_SAFE_INTEGER;
const crmCookieAge = 400 * 24 * 60 * 60;
const logisticsCookieAge = 8 * 60 * 60;
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
export function findSession(data: OperationsData, request: IncomingMessage) {
  const token = sessionToken(request);
  const audience = logisticsRequest(request) ? 'logistics' : undefined;
  if (!token) return undefined;
  const sessionHash = hash(token);
  const now = Date.now();
  return data.accounts?.sessions.find(row => row.hash === sessionHash && row.expiresAt > now && row.audience === audience);
}
export function authenticate(data: OperationsData, request: IncomingMessage): AccountUser | null {
  const audience = logisticsRequest(request) ? 'logistics' : undefined;
  const session = findSession(data, request);
  const user = session && data.accounts?.users.find(row=>row.id===session.userId && row.active && !row.deletedAt);
  return user && driverAccountAvailable(data, user) && (!audience || user.role === 'driver' || hasSection(user, 'trips')) ? publicUser(user) : null;
}
export function sessionCookie(token: string, secure: boolean, audience?: 'logistics') {
  const name = audience ? logisticsCookieName : cookieName;
  const path = audience ? '/api/logistics' : '/';
  const age = audience ? logisticsCookieAge : crmCookieAge;
  return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${token ? age : 0}${secure ? '; Secure' : ''}`;
}
export function requireUser(data: OperationsData, request: IncomingMessage) { const user=authenticate(data,request); if(!user)throw new ApiError(401,'Войдите в приложение.');return user; }
export function requireAccounts(user: AccountUser) { if (!hasSection(user, 'accounts')) throw new ApiError(403, 'Раздел недоступен. Обратитесь к администратору.'); }
export function requireManage(user: AccountUser) { if(!canManage(user))throw new ApiError(403,'Действие доступно директору и администратору.'); }
export function requireDeveloper(actor: AccountUser) {
  if (!isDeveloper(actor)) throw new ApiError(403, 'Учётными записями разработчиков управляет разработчик.');
}

function requireRemainingAccountAuthority(accounts: AccountsData, previous: StoredUser, next?: StoredUser) {
  if (!previous.active) return;
  const remaining = accounts.users.filter(user => user.id !== previous.id && user.active && !user.deletedAt);
  if (next?.active) remaining.push(next);
  if (isDeveloper(previous) && !remaining.some(isDeveloper)) throw new ApiError(409, 'Нельзя отключить последнего разработчика.');
  if (previous.role === 'director' && !remaining.some(user => isDeveloper(user) || user.role === 'director' && hasSection(user, 'accounts'))) {
    throw new ApiError(409, next?.active && next.role === 'director'
      ? 'Оставьте хотя бы одному директору доступ к управлению учётными записями.'
      : 'Нельзя отключить или удалить последнего активного директора.');
  }
}

export function validateAccounts(value: AccountsData) {
  if(!value || !Array.isArray(value.users) || !Array.isArray(value.sessions) || !value.attempts || typeof value.attempts!=='object')throw new Error('Invalid accounts');
  const ids=new Set<string>(), logins=new Set<string>(), driverIds=new Set<string>();
  for(const u of value.users){
    if (u.avatar !== undefined && !validStoredAvatar(u.avatar)) throw new Error('Invalid profile avatar');
    if (u.passwordCiphertext !== undefined && !validPasswordCiphertext(u.passwordCiphertext)) throw new Error('Invalid password ciphertext');
    if (u.deletedAt !== undefined && (typeof u.deletedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(u.deletedAt) || !Number.isFinite(Date.parse(u.deletedAt)) || new Date(u.deletedAt).toISOString() !== u.deletedAt || u.active || typeof u.deletedBy !== 'string' || !u.deletedBy) || u.deletedBy !== undefined && u.deletedAt === undefined) throw new Error('Invalid user deletion');
    if (u.customSections !== undefined && (u.customSections !== true || !Array.isArray(u.sections))) throw new Error('Invalid section override');
    if (u.directoryGrants !== undefined && !validDirectoryGrants(u.directoryGrants)) throw new Error('Invalid directory grants');
    if (u.sections !== undefined && (!Array.isArray(u.sections) || new Set(u.sections).size !== u.sections.length || u.sections.some(id => id !== 'settlements' && !sections.some(section => section.id === id)))) throw new Error('Invalid sections');
    if(!u || typeof u.id!=='string' || !u.id || ids.has(u.id) || typeof u.name!=='string' || !u.name || typeof u.login!=='string' || !accountLoginPattern.test(u.login) || logins.has(u.login) || !Object.hasOwn(roleNames, u.role) || (u.managerId!==null && typeof u.managerId!=='string') || typeof u.active!=='boolean' || !Number.isSafeInteger(u.version) || u.version<1 || !/^[a-f0-9]{128}$/.test(u.passwordHash) || !/^[a-f0-9]{32}$/.test(u.salt))throw new Error('Invalid user');
    if (u.role === 'driver') {
      if (typeof u.driverId !== 'string' || !u.driverId || driverIds.has(u.driverId) || u.managerId !== null || !Array.isArray(u.sections) || u.sections.length) throw new Error('Invalid driver account');
      driverIds.add(u.driverId);
    } else if (u.driverId !== undefined) throw new Error('Invalid employee driver binding');
    ids.add(u.id);logins.add(u.login);
  }
  if(value.users.length && !value.users.some(u=>u.active && (isDeveloper(u) || u.role === 'director')))throw new Error('Director required');
  for(const row of value.sessions)if(!row || !ids.has(row.userId) || !/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.expiresAt) || row.audience !== undefined && row.audience !== 'logistics')throw new Error('Invalid session');
  for(const [key,row] of Object.entries(value.attempts))if(!/^[a-f0-9]{64}$/.test(key) || !row || !Number.isSafeInteger(row.count) || row.count<0 || !Number.isSafeInteger(row.until))throw new Error('Invalid login attempt');
}
function text(input: Record<string,unknown>, key:string, max=120) { const v=input[key];if(typeof v!=='string' || !v.trim() || v.trim().length>max)throw new ApiError(400,`Проверьте поле «${key}».`);return v.trim(); }
function parseAccountLogin(value: unknown) {
  const login = normalizeAccountLogin(value);
  if (!accountLoginPattern.test(login)) throw new ApiError(400, 'Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание.');
  return login;
}

function requireAvailableLogin(accounts: AccountsData, login: string, currentId?: string) {
  if (accounts.users.some(user => user.login === login && user.id !== currentId)) throw new ApiError(409, 'Этот логин уже используется.');
}

function moveLoginThrottle(accounts: AccountsData, previous: string, next: string) {
  const now = Date.now();
  const previousKeys = [loginAttemptKey(previous), hash(previous)].filter(key => key !== legacyGlobalLoginKey);
  const nextKeys = [loginAttemptKey(next), hash(next)].filter(key => key !== legacyGlobalLoginKey);
  const active = [...previousKeys, ...nextKeys].flatMap(key => {
    const attempt = accounts.attempts[key];
    return attempt && attempt.until > now ? [attempt] : [];
  });
  for (const key of previousKeys) delete accounts.attempts[key];
  if (active.length) accounts.attempts[loginAttemptKey(next)] = {
    count: Math.min(5, Math.max(...active.map(attempt => attempt.count))),
    until: Math.max(...active.map(attempt => attempt.until)),
  };
}

function checkPasswordLength(input: unknown): asserts input is string {
  if (typeof input !== 'string' || input.length < 12 || input.length > 256) throw new ApiError(400, 'Пароль должен содержать от 12 до 256 символов.');
}
async function derivePasswordFields(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return { salt, passwordHash: derived.toString('hex') };
}
export async function passwordFields(input: unknown, passwordKey: string | null | undefined = process.env.ARTEL_ACCOUNT_PASSWORD_KEY) {
  checkPasswordLength(input);
  const fields = await derivePasswordFields(input);
  return { ...fields, passwordCiphertext: passwordKey == null ? undefined : encryptAccountPassword(input, fields, passwordKey) };
}
export async function saveUser(data:OperationsData,snapshot:Snapshot,input:Record<string,unknown>,id?:string,setup=false,passwordKey = process.env.ARTEL_ACCOUNT_PASSWORD_KEY, actor?: AccountUser) {
  if(Object.keys(input).some(k=>!['name','login','password','role','managerId','active','version','setupToken','sections','directoryGrants'].includes(k)))throw new ApiError(400,'Неизвестное поле пользователя.');
  const accounts=data.accounts ??= {users:[],sessions:[],attempts:{}};
  const previous=id?accounts.users.find(u=>u.id===id):undefined;
  if (actor && (input.role === 'developer' || previous && isDeveloper(previous))) requireDeveloper(actor);
  if (previous?.role === 'driver') throw new ApiError(403, 'Управляйте доступом водителя в разделе «Сотрудники и доступ».');
  if(id && (!previous || previous.deletedAt))throw new ApiError(404,'Пользователь не найден.');
  if(previous && input.version!==previous.version)throw new ApiError(409,'Пользователь уже изменён. Обновите список.');
  const name = text(input, 'name'), login = parseAccountLogin(input.login);
  requireAvailableLogin(accounts, login, id);
  const role=setup?'director':input.role;
  if(typeof role !== 'string' || !['developer','director','admin','employee','manager'].includes(role))throw new ApiError(400,'Выберите роль пользователя.');
  const managerId=input.managerId || null;
  if(managerId!==null && (typeof managerId!=='string' || !snapshot.directories?.managers.some(m=>m.id===managerId)))throw new ApiError(400,'Выберите сотрудника из справочника.');
  if(managerId && accounts.users.some(u=>u.id!==id && u.managerId===managerId && u.active))throw new ApiError(409,'Сотрудник уже связан с активной учётной записью.');
  if(input.active!==undefined && typeof input.active!=='boolean')throw new ApiError(400,'Некорректный статус пользователя.');
  const active=setup?true:input.active!==false;
  if (input.sections !== undefined && (!Array.isArray(input.sections) || new Set(input.sections).size !== input.sections.length || input.sections.some(id => id !== 'settlements' && !sections.some(section => section.id === id)))) throw new ApiError(400, 'Некорректный список разделов.');
  if (input.directoryGrants !== undefined && !validDirectoryGrants(input.directoryGrants)) throw new ApiError(400, 'Некорректный список справочников.');
  if (previous?.passwordCiphertext && input.password && !passwordKey && role !== 'developer') throw new ApiError(503, 'Хранилище паролей недоступно.');
  const accountRole = role as AccountUser['role'];
  const encryptionKey = role === 'developer' ? null : passwordKey;
  const permissions = input.sections as SectionId[] | undefined;
  const user: StoredUser = {
    ...(previous ?? await passwordFields(input.password, encryptionKey)),
    ...(previous && input.password ? await passwordFields(input.password, encryptionKey) : {}),
    id: id ?? `user-${randomUUID()}`, name, login, role: accountRole, managerId: managerId as string | null, active, version: (previous?.version ?? 0) + 1,
  };
  if (isDeveloper(user)) {
    delete user.sections;
    delete user.customSections;
    delete user.directoryGrants;
    delete user.passwordCiphertext;
  } else {
    if (permissions !== undefined && !setup) {
      user.sections = [...new Set(permissions.map(id => id === 'settlements' ? 'overview' : id))];
      if (isAdministrator(user)) user.customSections = true;
      else delete user.customSections;
    } else if (!previous || isDeveloper(previous) || isAdministrator(previous) && !isAdministrator(user)) {
      delete user.customSections;
      user.sections = isScopedEmployee(user) ? previous ? [] : [...defaultEmployeeSections] : effectiveSections(user);
    }
    if (input.directoryGrants !== undefined && !setup) user.directoryGrants = [...input.directoryGrants as NonNullable<AccountUser['directoryGrants']>];
    else if (previous && isAdministrator(previous) !== isAdministrator(user)) delete user.directoryGrants;
  }
  if (previous) requireRemainingAccountAuthority(accounts, previous, user);
  if (!setup && role !== 'developer' && !managerId && (!previous || isScopedEmployee({ role: role as AccountUser['role'] }) && active)) throw new ApiError(400, 'Свяжите учётную запись с сотрудником справочника.');
  if (previous) {
    if (hasSection(previous, 'invoices')) queueInvoiceRevocations(data, accounts.sessions.filter(session => session.userId === id && !session.audience).map(session => session.hash));
  }
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
  if (isDeveloper(user)) requireDeveloper(actor);
  if (user.role === 'driver') throw new ApiError(403, 'Управляйте доступом водителя в разделе «Сотрудники и доступ».');
  if (input.confirmationName !== user.name) throw new ApiError(400, 'Для подтверждения введите точное имя сотрудника.');
  if (actor.id === id) throw new ApiError(409, 'Нельзя удалить свою учётную запись.');
  // The same DELETE can be safely retried after a lost response, without another revision.
  if (user.deletedAt && (input.version === user.version - 1 || input.version === user.version)) return { id, deleted: true, changed: false };
  if (input.version !== user.version) throw new ApiError(409, 'Пользователь уже изменён. Обновите список.');
  requireRemainingAccountAuthority(accounts, user);
  const tasks = data.work?.tasks.filter(row => workAssigneeIds(row).includes(id) && !row.archivedAt && !isClosedWorkStatus(row.status)).length ?? 0;
  const companies = data.work?.companyRecords.filter(row => row.assigneeId === id && !row.archivedAt).length ?? 0;
  if (tasks || companies) throw new ApiError(409, `У сотрудника есть незавершённые записи: задачи — ${tasks}, работа с компаниями — ${companies}. В разделе «Работа» передайте их другому сотруднику или завершите и архивируйте, затем повторите удаление.`);
  if (hasSection(user, 'invoices')) queueInvoiceRevocations(data, accounts.sessions.filter(session => session.userId === id && !session.audience).map(session => session.hash));
  user.active = false;
  delete user.avatar;
  user.deletedAt = new Date().toISOString();
  user.deletedBy = actor.id;
  user.version += 1;
  accounts.sessions = accounts.sessions.filter(session => session.userId !== id);
  if (data.push) {
    const deviceIds = new Set(data.push.devices.filter(device => device.userId === id).map(device => device.id));
    data.push.devices = data.push.devices.filter(device => device.userId !== id);
    if (data.push.preferences) delete data.push.preferences[id];
    for (const [key, delivery] of Object.entries(data.push.deliveries)) if (deviceIds.has(delivery.deviceId)) delete data.push.deliveries[key];
    for (const [key, probe] of Object.entries(data.push.probes ?? {})) if (probe.userId === id) delete data.push.probes![key];
    for (const [key, assignment] of Object.entries(data.push.taskAssignments ?? {})) if (assignment.assigneeId === id) delete data.push.taskAssignments![key];
  }
  return { id, deleted: true, changed: true };
}
interface LoginResult { status: number; token?: string; user?: AccountUser; error?: string }
const loginName = (input: Record<string, unknown>) => normalizeAccountLogin(input.login).slice(0, 64);
const loginIdentity = (user: StoredUser | undefined): string | null => user ? JSON.stringify([
  user.id, user.login, user.passwordHash, user.salt, user.version, user.active, user.deletedAt,
  user.role, user.managerId, user.driverId, user.sections, user.customSections, user.directoryGrants,
]) : null;

const profileAttemptLimit = 5;
const profileAttemptWindow = 15 * 60 * 1000;
const profileThrottled = () => new ApiError(429, 'Слишком много попыток смены пароля. Повторите через 15 минут.');
const profileConflict = () => new ApiError(409, 'Профиль уже изменён. Обновите страницу.');

function profileAccount(data: OperationsData, request: IncomingMessage) {
  const actor = requireUser(data, request);
  const accountHeader = request.headers['x-artel-account'];
  if (accountHeader !== undefined && accountHeader !== actor.id) throw new ApiError(401, 'Пользователь изменился. Обновите страницу.');
  const accounts = data.accounts!;
  const session = findSession(data, request);
  if (!session) throw new ApiError(401, 'Войдите в приложение.');
  return { accounts, user: accounts.users.find(row => row.id === actor.id)!, session };
}

function revokeOtherProfileSessions(data: OperationsData, accounts: AccountsData, user: StoredUser, keepHash: string) {
  const revoked = accounts.sessions.filter(session => session.userId === user.id && session.hash !== keepHash);
  if (hasSection(user, 'invoices')) queueInvoiceRevocations(data, revoked.filter(session => !session.audience).map(session => session.hash));
  accounts.sessions = accounts.sessions.filter(session => session.userId !== user.id || session.hash === keepHash);
  if (data.push) {
    const revokedDevices = new Set(data.push.devices.filter(device => device.userId === user.id && device.sessionHash !== keepHash).map(device => device.id));
    data.push.devices = data.push.devices.filter(device => !revokedDevices.has(device.id));
    for (const [key, delivery] of Object.entries(data.push.deliveries)) if (revokedDevices.has(delivery.deviceId)) delete data.push.deliveries[key];
    for (const [key, probe] of Object.entries(data.push.probes ?? {})) if (revokedDevices.has(probe.deviceId)) delete data.push.probes![key];
  }
}

/** Prepare credentials outside the write lock. A fresh session, account
 * version and credential identity must still match when committing. */
export async function prepareProfileUpdate(data: OperationsData, request: IncomingMessage, input: Record<string, unknown>) {
  const { accounts, user, session } = profileAccount(data, request);
  const { version, currentPassword, newPassword } = input;
  const changingPassword = Object.hasOwn(input, 'currentPassword') || Object.hasOwn(input, 'newPassword');
  if (Object.keys(input).some(key => !['version', 'name', 'login', 'currentPassword', 'newPassword', 'avatar'].includes(key)) || !Number.isSafeInteger(version) || Number(version) < 1) {
    throw new ApiError(400, 'Передайте текущую версию и поля своего профиля.');
  }
  if (version !== user.version) throw profileConflict();
  const name = Object.hasOwn(input, 'name') ? text(input, 'name') : undefined;
  const login = Object.hasOwn(input, 'login') ? parseAccountLogin(input.login) : undefined;
  const avatar = Object.hasOwn(input, 'avatar') ? parseProfileAvatar(input.avatar) : undefined;
  if (name === undefined && login === undefined && !changingPassword && avatar === undefined) throw new ApiError(400, 'Укажите имя, логин, новый пароль или аватар.');

  const identity = loginIdentity(user);
  const accountId = user.id;
  const sessionHash = session.hash;
  const attemptKey = hash(`artel:auth:profile-password:${accountId}`);
  let credentials: Awaited<ReturnType<typeof derivePasswordFields>> | undefined;
  if (changingPassword) {
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 256) throw new ApiError(400, 'Введите текущий пароль.');
    checkPasswordLength(newPassword);
    if (currentPassword === newPassword) throw new ApiError(400, 'Новый пароль должен отличаться от текущего.');
    const previousAttempt = accounts.attempts[attemptKey];
    if (previousAttempt && previousAttempt.until > Date.now() && previousAttempt.count >= profileAttemptLimit) throw profileThrottled();
    const { salt, passwordHash } = user;
    const actual = await performanceSpan('auth.kdf', () => scrypt(currentPassword, salt, 64)) as Buffer;
    if (timingSafeEqual(actual, Buffer.from(passwordHash, 'hex'))) credentials = await derivePasswordFields(newPassword);
  }

  return (fresh: OperationsData) => {
    const current = profileAccount(fresh, request);
    if (current.user.id !== accountId || current.session.hash !== sessionHash) throw new ApiError(401, 'Пользователь изменился. Обновите страницу.');
    if (loginIdentity(current.user) !== identity) throw profileConflict();
    if (login !== undefined) requireAvailableLogin(current.accounts, login, current.user.id);
    if (changingPassword) {
      const now = Date.now(), previous = current.accounts.attempts[attemptKey];
      const attempt = previous && previous.until > now ? previous : undefined;
      if (attempt && attempt.count >= profileAttemptLimit) throw profileThrottled();
      if (!credentials) {
        current.accounts.attempts[attemptKey] = { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + profileAttemptWindow };
        return { result: { status: 403, error: 'Текущий пароль неверный.' }, changed: true };
      }
      Object.assign(current.user, credentials);
      // A self-chosen password can be verified but cannot be read back.
      delete current.user.passwordCiphertext;
      delete current.accounts.attempts[attemptKey];
      revokeOtherProfileSessions(fresh, current.accounts, current.user, sessionHash);
    }
    const avatarChanged = avatar !== undefined && !sameAvatar(current.user.avatar, avatar);
    const loginChanged = login !== undefined && login !== current.user.login;
    const changed = loginChanged || avatarChanged || changingPassword || name !== undefined && name !== current.user.name;
    if (name !== undefined) current.user.name = name;
    if (loginChanged) {
      // Sessions, push and directory links belong to the stable account ID.
      moveLoginThrottle(current.accounts, current.user.login, login);
      current.user.login = login;
    }
    if (avatarChanged) {
      if (avatar) current.user.avatar = avatar;
      else delete current.user.avatar;
    }
    if (changed) current.user.version++;
    return { result: { status: 200, user: publicUser(current.user) }, changed };
  };
}

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
  const actual = await performanceSpan('auth.kdf', () => scrypt(password, salt, 64)) as Buffer;
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
  const now=Date.now(), key=loginAttemptKey(name), globalKey=hash('artel:auth:global-login-limit:v2');
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
  migrateAttempt(legacyGlobalLoginKey,globalKey,50,false);
  for(const account of accounts.users)migrateAttempt(hash(account.login),loginAttemptKey(account.login),5,hash(account.login)!==legacyGlobalLoginKey);
  if(accounts.attempts[legacyGlobalLoginKey]){delete accounts.attempts[legacyGlobalLoginKey];onChanged();}
  if(accountLoginPattern.test(name))migrateAttempt(hash(name),key,5);
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
  const sessions = accounts.sessions.filter(session => session.expiresAt > now);
  const persistent = sessions.filter(session => !session.audience && session.expiresAt === persistentSessionExpiry);
  const temporary = sessions.filter(session => session.audience || session.expiresAt !== persistentSessionExpiry);
  accounts.sessions = [...persistent, ...temporary.slice(audience ? -499 : -500)];
  accounts.sessions.push({
    hash: hash(token), userId: user.id,
    expiresAt: audience ? now + logisticsCookieAge * 1000 : persistentSessionExpiry,
    ...(audience ? { audience } : {}),
  });
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
