import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
const root=resolve(import.meta.dirname,'..'), folder=resolve(root,'../built-review');await mkdir(folder,{recursive:true});
await cp(resolve(root,'../preview/snapshot'),resolve(folder,'snapshot'),{recursive:true});await cp(resolve(root,'../preview/store'),resolve(folder,'store'),{recursive:true});
process.env.ARTEL_OPERATOR_QA_BUILT='1';
const runtime=await startOperatorQaServer({root,snapshotDirectory:resolve(folder,'snapshot'),operationsDirectory:resolve(folder,'store')});
const access=JSON.parse(await readFile(resolve(root,'../preview/access.json'),'utf8'));
try{
 for(const script of ['verify_operator_review.mjs','verify_operator_push_state.mjs']){
  const code=await new Promise(done=>{const child=spawn(process.execPath,['--import','tsx',resolve(root,'scripts',script)],{cwd:root,stdio:'inherit',env:{...process.env,ARTEL_REVIEW_BUILT:'1',ARTEL_REVIEW_BASE:runtime.base,ARTEL_REVIEW_COOKIE:access.cookie}});child.on('exit',done)});
  if(code!==0)throw new Error(script+' failed');
 }
}finally{await runtime.server.close()}
