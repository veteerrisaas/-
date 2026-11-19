import path from 'node:path';
import { chromium, devices } from 'playwright';
import { ROOT } from './config.js';
const context=await chromium.launchPersistentContext(path.join(ROOT,'browser-profile-reserva'),{...devices['iPhone 13'],headless:false});
const page=context.pages()[0]??await context.newPage();
try {
 await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(5000);
 console.log((await page.locator('body').innerText()).slice(0,7000));
 console.log(JSON.stringify(await page.locator('svg,a,button,input[type=file]').evaluateAll(es=>es.map(e=>({tag:e.tagName,href:e.getAttribute('href'),aria:e.getAttribute('aria-label'),text:e.tagName==='svg'?e.querySelector('title')?.textContent:e.innerText?.slice(0,80),accept:e.getAttribute('accept')}))),null,2));
 await page.screenshot({path:path.join(ROOT,'screenshots','reserva-mobile-stories.png')});
} finally {await context.close();}
