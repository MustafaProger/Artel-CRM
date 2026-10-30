import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,tileSvg} from './map-cards-fixture.mjs';
import {authenticateContext} from './qa-auth.mjs';
const rt=await fixture(),out=resolve(import.meta.dirname,'../../ui',process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source');await mkdir(out,{recursive:true});
const report={passed:false,synthetic:true,checks:[],axe:[],errors:[],external:[]};
try{
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await launcher.launch();try{
   const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles',serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,rt.base,rt.cookie);
   await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==rt.base){report.external.push(url.origin);return route.abort()}if(url.pathname==='/api/maps/yandex/tiles')return route.fulfill({contentType:'image/svg+xml',body:tileSvg});return route.continue()});
   const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date('2026-10-29T20:59:00Z')});
   await page.goto(rt.base+'/#trips');await page.getByRole('button',{name:'Карта',exact:true}).click();
   await expect(page.locator('.trip-map-list > li')).toHaveCount(5);await expect(page.locator('.trip-map-marker')).toHaveCount(4);await expect(page.locator('.trip-map-depot-marker')).toHaveCount(1);
   await expect(page.locator('.trip-map-list')).toContainText('Прошлый месяц');await expect(page.locator('.trip-map-list')).not.toContainText('Послезавтра');await expect(page.locator('.trip-map-list')).not.toContainText('Без даты');
   const card=page.locator('.trip-map-list > li').filter({hasText:'СТРОЙСТАНДАРТ ООО'});
   for(const width of [320,375,390,640,768,1024,1440]){
    await page.setViewportSize({width,height:1000});await card.scrollIntoViewIfNeeded();
    const geometry=await page.locator('.trip-map-list').evaluate(el=>({page:document.documentElement.scrollWidth,cards:[...el.children].map(card=>{const r=card.getBoundingClientRect();return {width:r.width,items:[...card.querySelectorAll('.trip-map-list-info,.trip-map-list-date,.trip-map-list-volume,.trip-map-list-actions')].map(n=>{const b=n.getBoundingClientRect();return {left:b.left-r.left,right:b.right-r.left,scroll:n.scrollWidth,client:n.clientWidth}})}})}));
    assert.ok(geometry.page<=width+1,JSON.stringify(geometry));for(const c of geometry.cards)for(const n of c.items){assert.ok(n.left>=0&&n.right<=c.width+1,JSON.stringify(geometry));assert.ok(n.scroll<=n.client+1,JSON.stringify(geometry))}
    const info=await card.locator('.trip-map-list-info').boundingBox(),date=await card.locator('time').boundingBox(),vol=await card.locator('.trip-map-list-volume').boundingBox();assert.ok(vol.x>=info.x+info.width-1);assert.ok(date.y>info.y);
    const a=await new AxeBuilder({page}).include('.trip-requests-map').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();report.axe.push({engine,width,violations:a.violations});assert.equal(a.violations.length,0,JSON.stringify(a.violations));
    await page.locator('.trip-map-list').screenshot({path:resolve(out,`${engine}-${width}.png`)});report.checks.push({engine,width,geometry});console.log('PASS',engine,width);
   }
   await card.locator('.trip-map-list-location').focus();await page.keyboard.press('Enter');await expect(page.getByRole('region',{name:'Информация о точке доставки'})).toBeVisible();await expect(page.locator('.trip-map-details')).toContainText('10 228 л');
   await page.getByRole('button',{name:'Закрыть карточку точки',exact:true}).click();
   await card.getByRole('button',{name:/Изменить точку/}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Отмена',exact:true}).click();
   await expect(card.getByRole('link')).toHaveAttribute('href',/yandex/);report.checks.push({engine,interaction:'keyboard focus, map card, edit/cancel, external link'});
   await page.clock.fastForward(90000);await expect(page.locator('.trip-map-list > li')).toHaveCount(6);await expect(page.locator('.trip-map-list')).toContainText('Прошлый месяц');await expect(page.locator('.trip-map-list')).toContainText('Вчера');await expect(page.locator('.trip-map-list')).toContainText('Послезавтра');report.checks.push({engine,midnight:'past retained, new tomorrow included in Los Angeles timezone'});
   await context.route('**/api/trip-requests',async route=>{const response=await route.fetch();const value=await response.json();return route.fulfill({json:{...value,requests:[]}})});
   await page.reload();await page.getByRole('button',{name:'Карта',exact:true}).click();await expect(page.locator('.trip-map-summary')).toContainText('Нет заявок до завтра включительно');await expect(page.locator('.trip-map-depot-marker')).toHaveCount(1);report.checks.push({engine,empty:'depot preserved'});
  }finally{await browser.close()}
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.passed=true;
}finally{await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await rt.server.close();await rm(rt.directory,{recursive:true,force:true,maxRetries:5})}
