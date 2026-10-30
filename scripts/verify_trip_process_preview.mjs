import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
const base='http://127.0.0.1:5187', dir='.local/trips-review';await mkdir(dir,{recursive:true});
const report={checks:[],violations:[],browserErrors:[]};
for(const [name,launcher] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch();const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});const page=await context.newPage();page.on('pageerror',e=>report.browserErrors.push(e.message));
 // Establish the synthetic session before navigation, as in the isolated process suite.
 const login=await context.request.get(base+'/__preview');assert.ok(login.ok());
 await page.goto(base+'/#trips');await page.getByRole('button',{name:'В процессе',exact:true}).click();
 const panel=page.getByRole('region',{name:'Процесс рейсов'});await panel.getByTestId('execution-trip').first().waitFor();
 assert.equal(await panel.getByTestId('execution-trip').count(),5);
 await panel.getByLabel('Этап рейса',{exact:true}).selectOption('enroute');assert.equal(await panel.getByTestId('execution-trip').count(),2);
 await panel.getByLabel('Машина',{exact:true}).selectOption('vehicle');assert.equal(await panel.getByTestId('execution-trip').count(),1);
 await panel.getByLabel('Поиск машины или рейса').fill('невозможный поиск');await panel.getByRole('button',{name:'Сбросить фильтры'}).click();assert.equal(await panel.getByTestId('execution-trip').count(),7);
 await panel.getByRole('button',{name:/^В работе/}).click();assert.equal(await panel.getByTestId('execution-trip').count(),5);
 const first=panel.getByTestId('execution-trip').first();await first.locator('summary').first().focus();await page.keyboard.press('Enter');assert.equal(await first.getAttribute('open'),'');
 await panel.getByText('Как работают статусы?',{exact:true}).click();assert.equal(await panel.getByRole('definition').count(),5);
 await panel.getByText('Как работают статусы?',{exact:true}).click();
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`${dir}/${name}-${width}.png`,fullPage:true});}
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();report.violations.push(...axe.violations);assert.deepEqual(axe.violations,[]);
 report.checks.push(`${name}: real API fixture, search, vehicle and stage filters, reset, keyboard disclosure, help, four widths, axe`);await browser.close();
}
assert.deepEqual(report.browserErrors,[]);report.passed=true;await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
