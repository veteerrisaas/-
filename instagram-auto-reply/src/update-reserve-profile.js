import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';
import { openBrowser, isLoggedIn } from './browser.js';
const {context,page}=await openBrowser({headless:false,profilePath:path.join(ROOT,'browser-profile-reserva')});
const inspect=async()=>{
 console.log((await page.locator('body').innerText()).slice(0,8000));
 console.log(JSON.stringify(await page.locator('input,textarea,[contenteditable]').evaluateAll(es=>es.map(e=>({tag:e.tagName,type:e.getAttribute('type'),name:e.getAttribute('name'),id:e.id,aria:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')}))),null,2));
};
try {
 await page.goto('https://www.instagram.com/golsdodia.imortal/',{waitUntil:'domcontentloaded'});
 if(!await isLoggedIn(context)) throw new Error('Sessao desconectada');
 await page.getByRole('link',{name:/Editar perfil|Edit profile/}).click();
 await page.waitForTimeout(3000);
 if(!(await page.locator('body').innerText()).includes('golsdodia.imortal')) throw new Error('Conta divergente');
 const bio='📊 | Analista esportivo\n⚽️ | 7 anos vivendo do futebol\nLINK DA PLATAFORMA 100% CONFIÁVEL 👇🏼';
 if(process.argv.includes('--apply')) {
  if(await page.locator('#pepBio').inputValue()!==bio) {
   await page.locator('#pepBio').fill(bio);
   await page.getByRole('button',{name:/^Enviar$|^Submit$/}).click();
   await page.waitForTimeout(2500);
  }
  console.log('BIO: '+(await page.locator('body').innerText()).slice(-1800));
  await page.getByText(/^Mudar foto$|^Change photo$/).click();
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByText(/^Carregar foto$|^Upload photo$/).click();
  const chooser=await chooserPromise;
  await chooser.setFiles(path.join(ROOT,'..','publicacoes-conta-reserva','publicacoes','profile_photos','001','01_17913742611229836.jpg'));
  await page.waitForTimeout(5000);
  console.log((await page.locator('body').innerText()).slice(-2400));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('#pepBio').waitFor();
  if(await page.locator('#pepBio').inputValue()!==bio) throw new Error('Bio salva nao confere');
  await page.goto('https://www.instagram.com/golsdodia.imortal/',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(3000);
  console.log((await page.locator('body').innerText()).slice(0,650));
  await page.screenshot({path:path.join(ROOT,'screenshots','reserva-perfil-atualizado.png')});
 } else await inspect();
 await page.screenshot({path:path.join(ROOT,'screenshots','reserva-editar-perfil.png')});
}finally{await context.close();}
