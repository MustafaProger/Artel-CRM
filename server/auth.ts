import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';

const scrypt = promisify(derive);
interface StoredUser extends AccountUser { passwordHash: string; salt: string }
export interface AccountsData {
  users: StoredUser[];
  sessions: { hash: string; userId: string; expiresAt: number }[];
  attempts: Record<string, { count: number; until: number }>;
}
export const publicUser = (user: StoredUser): AccountUser => ({ id:user.id, name:user.name, login:user.login, role:user.role, managerId:user.managerId, active:user.active, version:user.version });
export const activeUsers = (data: OperationsData) => (data.accounts?.users ?? []).filter(user=>user.active).map(publicUser);
export const canManage = (user: AccountUser) => user.role === 'director' || user.role === 'admin';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const cookieName = 'artel_session';
export function sessionToken(request: IncomingMessage) {
  const token = request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function authenticate(data: OperationsData, request: IncomingMessage): AccountUser | null {
  const token = sessionToken(request);
  const session = token && data.accounts?.sessions.find(row=>row.hash===hash(token) && row.expiresAt>Date.now());
  const user = session && data.accounts?.users.find(row=>row.id===session.userId && row.active);
  return user ? publicUser(user) : null;
}
export function sessionCookie(token: string, secure: boolean) { return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?28800:0}${secure?'; Secure':''}`; }
export function requireUser(data: OperationsData, request: IncomingMessage) { const user=authenticate(data,request); if(!user)throw new ApiError(401,'Войдите в приложение.');return user; }
export function requireManage(user: AccountUser) { if(!canManage(user))throw new ApiError(403,'Действие доступно директору и администратору.'); }
export function validateAccounts(value: AccountsData) {
  if(!value || !Array.isArray(value.users) || !Array.isArray(value.sessions) || !value.attempts || typeof value.attempts!=='object')throw new Error('Invalid accounts');
  const ids=new Set<string>(), logins=new Set<string>();
  for(const u of value.users){
    if(!u || typeof u.id!=='string' || !u.id || ids.has(u.id) || typeof u.name!=='string' || !u.name || typeof u.login!=='string' || !/^[a-z0-9._-]{3,64}$/.test(u.login) || logins.has(u.login) || !['director','admin','manager'].includes(u.role) || (u.managerId!==null && typeof u.managerId!=='string') || typeof u.active!=='boolean' || !Number.isSafeInteger(u.version) || u.version<1 || !/^[a-f0-9]{128}$/.test(u.passwordHash) || !/^[a-f0-9]{32}$/.test(u.salt))throw new Error('Invalid user');
    ids.add(u.id);logins.add(u.login);
  }
  if(value.users.length && !value.users.some(u=>u.active && u.role==='director'))throw new Error('Director required');
  for(const row of value.sessions)if(!row || !ids.has(row.userId) || !/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.expiresAt))throw new Error('Invalid session');
  for(const [key,row] of Object.entries(value.attempts))if(!/^[a-f0-9]{64}$/.test(key) || !row || !Number.isSafeInteger(row.count) || row.count<0 || !Number.isSafeInteger(row.until))throw new Error('Invalid login attempt');
}
function text(input: Record<string,unknown>, key:string, max=120) { const v=input[key];if(typeof v!=='string' || !v.trim() || v.trim().length>max)throw new ApiError(400,`Проверьте поле «${key}».`);return v.trim(); }
async function passwordFields(input: unknown) {
  if(typeof input!=='string' || input.length<12 || input.length>256)throw new ApiError(400,'Пароль должен содержать от 12 до 256 символов.');
  const salt=randomBytes(16).toString('hex');return {salt,passwordHash:(await scrypt(input,salt,64) as Buffer).toString('hex')};
}
export async function saveUser(data:OperationsData,snapshot:Snapshot,input:Record<string,unknown>,id?:string,setup=false) {
  if(Object.keys(input).some(k=>!['name','login','password','role','managerId','active','version','setupToken'].includes(k)))throw new ApiError(400,'Неизвестное поле пользователя.');
  const accounts=data.accounts ??= {users:[],sessions:[],attempts:{}};
  const previous=id?accounts.users.find(u=>u.id===id):undefined;
  if(id && !previous)throw new ApiError(404,'Пользователь не найден.');
  if(previous && input.version!==previous.version)throw new ApiError(409,'Пользователь уже изменён. Обновите список.');
  const name=text(input,'name'),login=text(input,'login',64).toLowerCase();
  if(!/^[a-z0-9._-]{3,64}$/.test(login))throw new ApiError(400,'Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание.');
  if(accounts.users.some(u=>u.login===login && u.id!==id))throw new ApiError(409,'Этот логин уже используется.');
  const role=setup?'director':input.role;
  if(!['director','admin','manager'].includes(String(role)))throw new ApiError(400,'Выберите роль пользователя.');
  const managerId=input.managerId || null;
  if(managerId!==null && (typeof managerId!=='string' || !snapshot.directories?.managers.some(m=>m.id===managerId)))throw new ApiError(400,'Выберите сотрудника из справочника.');
  if(managerId && accounts.users.some(u=>u.id!==id && u.managerId===managerId && u.active))throw new ApiError(409,'Сотрудник уже связан с активной учётной записью.');
  if(input.active!==undefined && typeof input.active!=='boolean')throw new ApiError(400,'Некорректный статус пользователя.');
  const active=setup?true:input.active!==false;
  if(previous?.role==='director' && (!active || role!=='director') && !accounts.users.some(u=>u.id!==id && u.active && u.role==='director'))throw new ApiError(409,'Нельзя отключить последнего директора.');
  const user:StoredUser={...(previous??await passwordFields(input.password)),...(previous && input.password?await passwordFields(input.password):{}),id:id??`user-${randomUUID()}`,name,login,role:role as AccountUser['role'],managerId:managerId as string|null,active,version:(previous?.version??0)+1};
  if(previous)accounts.users[accounts.users.indexOf(previous)]=user;else accounts.users.push(user);
  if(previous)accounts.sessions=accounts.sessions.filter(s=>s.userId!==id);
  if (previous && !active && data.push) data.push.devices = data.push.devices.filter(device => device.userId !== id);
  return publicUser(user);
}
export async function login(data:OperationsData,input:Record<string,unknown>) {
  const accounts=data.accounts;
  if(!accounts?.users.length)throw new ApiError(403,'Сначала создайте учётную запись директора.');
  const name=typeof input.login==='string'?input.login.trim().toLowerCase().slice(0,64):'';
  const now=Date.now(), key=hash(name), globalKey=hash('artel-global-login-limit');
  for(const [k,a] of Object.entries(accounts.attempts))if(a.until<=now)delete accounts.attempts[k];
  if((accounts.attempts[key]?.count??0)>=5 || (accounts.attempts[globalKey]?.count??0)>=50)return {error:'Слишком много попыток. Повторите через 15 минут.',status:429};
  const user=accounts.users.find(u=>u.login===name && u.active);
  const password=typeof input.password==='string' && input.password.length<=256?input.password:'';
  const actual=await scrypt(password,user?.salt??'00000000000000000000000000000000',64) as Buffer;
  if(!user || !timingSafeEqual(actual,Buffer.from(user.passwordHash,'hex'))){
    for(const k of [key,globalKey])accounts.attempts[k]={count:(accounts.attempts[k]?.count??0)+1,until:accounts.attempts[k]?.until??now+900000};
    return {error:'Неверный логин или пароль.',status:401};
  }
  delete accounts.attempts[key];
  const token=randomBytes(32).toString('hex');
  accounts.sessions=accounts.sessions.filter(s=>s.expiresAt>now).slice(-499);
  accounts.sessions.push({hash:hash(token),userId:user.id,expiresAt:now+28800000});
  return {token,user:publicUser(user),status:200};
}
export function logout(data:OperationsData,request:IncomingMessage){const token=sessionToken(request);if(data.accounts && token)data.accounts.sessions=data.accounts.sessions.filter(s=>s.hash!==hash(token));}
