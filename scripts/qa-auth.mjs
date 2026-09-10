import { randomBytes } from 'node:crypto';
export async function bootstrapQaAuth(base) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('QA authentication is restricted to an isolated loopback server');
  const state = await (await fetch(base+'/api/auth/session')).json();
  if (!state.needsSetup) throw new Error('QA requires a fresh temporary operations store');
  const response=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'QA Директор',login:'qa.director',password:randomBytes(24).toString('hex')})});
  if(!response.ok)throw new Error('QA account setup failed');
  return {cookie:response.headers.get('set-cookie').split(';')[0],user:(await response.json()).user};
}
export function installQaFetchAuth(base,cookie){
  const original=globalThis.fetch;
  globalThis.fetch=(url,options={})=>{const target=String(url);if(target===base || target.startsWith(base+'/')){const headers=new Headers(options.headers);headers.set('cookie',cookie);return original(url,{...options,headers});}return original(url,options);};
  return ()=>{globalThis.fetch=original;};
}
export async function authenticateContext(context,base,cookie){
  const equals=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,equals),value:cookie.slice(equals+1),url:base,httpOnly:true,sameSite:'Strict'}]);
}
