import {fixture,tileSvg} from './map-cards-fixture.mjs';
import {requestToday} from '../web/src/trip-request-schedule.ts';
const runtime=await fixture(requestToday(),5196);
runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){
 const path=new URL(req.url,runtime.base).pathname;
 if(path==='/api/maps/yandex/tiles'){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end(tileSvg);return}
 if(path!=='/__preview')return next();
 res.setHeader('Set-Cookie',runtime.cookie+'; Path=/; HttpOnly; SameSite=Strict');res.writeHead(302,{Location:'/#trips'});res.end();
}});
console.log('LOCAL_PREVIEW '+runtime.base+'/__preview');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await runtime.server.close();process.exit(0)});
