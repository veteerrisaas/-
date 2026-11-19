import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { openBrowser, isLoggedIn, dismissPopups } from './browser.js';
const ACCOUNT = 'golsdodia.imortal';
const journal = path.join(ROOT, 'data', 'reserva-publicacoes.json');
const state = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal,'utf8')) : { account: ACCOUNT, inventory: [], deleted: [], uploaded: [] };
const save = () => fs.writeFileSync(journal, JSON.stringify(state,null,2));
const {context,page} = await openBrowser({headless:false,profilePath:path.join(ROOT,'browser-profile-reserva')});
const snapshot = async name => {
  console.log((await page.locator('body').innerText()).slice(0,10000));
  console.log(JSON.stringify(await page.getByRole('button').evaluateAll(bs=>bs.map(b=>({text:b.innerText,aria:b.getAttribute('aria-label')}))),null,2));
  console.log(JSON.stringify(await page.locator('svg').evaluateAll(es=>es.map(e=>({aria:e.getAttribute('aria-label'),title:e.querySelector('title')?.textContent}))),null,2));
  await page.screenshot({path:path.join(ROOT,'screenshots',`reserva-${name}.png`)});
};
try {
  await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(3000);
  if (!await isLoggedIn(context)) throw new Error('Sessao nao autenticada');
  await dismissPopups(page);
  const profile = page.getByRole('link',{name:/^Perfil$|^Profile$/i});
  const homeLinks = await page.locator('a[href]').evaluateAll(as=>as.map(a=>({href:a.getAttribute('href'),img:!!a.querySelector('img')})));
  if (!homeLinks.some(a=>a.href===`/${ACCOUNT}/` && a.img)) throw new Error('Identidade da conta nao confirmada');
  await page.goto(`https://www.instagram.com/${ACCOUNT}/`,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(3000);
  if (!await page.getByRole('link',{name:/Editar perfil|Edit profile/}).count()) throw new Error('Perfil nao pertence a sessao');
  for(let i=0;i<(state.inventory.length===23?0:8);i++) {
    const links=await page.locator('a[href]').evaluateAll(as=>as.map(a=>a.getAttribute('href')).filter(h=>/\/p\/|\/reel\//.test(h)));
    state.inventory=[...new Set([...state.inventory,...links])];save();
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(1300);
  }
  console.log(`Inventario: ${state.inventory.length}`);
  if(process.argv.includes('--publish')) {
    if(state.uploading) throw new Error(`Publicacao pendente de verificacao: ${state.uploading}`);
    const base=path.join(ROOT,'..','publicacoes-conta-reserva');
    const queue=JSON.parse(fs.readFileSync(path.join(base,'fila-publicacao.json'),'utf8'));
    const feed=queue.filter(r=>r.tipo_original!=='story' && !state.uploaded.includes(r.id));
    for(const item of feed) {
      console.log(`Preparando ${item.id}`);
      await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded'});
      await page.locator(`a[href="/${ACCOUNT}/"]`).first().waitFor();
      await page.locator('svg[aria-label="Novo post"]').click();
      await page.locator('input[type=file]').setInputFiles(item.arquivos_publicar.map(f=>path.join(base,f)));
      const next=page.getByRole('button',{name:/^Avançar$|^Next$/});
      await next.waitFor({state:'visible',timeout:60000});
      const crop=page.locator('svg[aria-label="Selecionar corte"]');
      if(await crop.count()) {
        await crop.click();
        const original=page.getByText(/^Original$/);
        if(await original.isVisible().catch(()=>false)) await original.click();
        else await crop.click();
      }
      await next.click();
      await page.waitForTimeout(1500);
      const caption=page.getByRole('textbox',{name:/Adicione uma legenda|Write a caption/i});
      if(!await caption.count()) {
        await next.waitFor({state:'visible',timeout:60000});await next.click();
      }
      await caption.waitFor({state:'visible',timeout:60000});
      await caption.fill(item.legenda);
      if((await caption.innerText()).trim()!==item.legenda.trim()) throw new Error('Legenda diverge do original');
      const dialog=page.getByRole('dialog').last();
      if(!((await dialog.innerText()).includes(ACCOUNT))) throw new Error('Conta no compositor diverge');
      state.uploading=item.id;save();
      await page.getByRole('button',{name:/^Compartilhar$|^Share$/}).click();
      try {
        await page.getByText(/Seu (post|reel) foi compartilhado|Sua publicação foi compartilhada|Your (post|reel) has been shared/i).first().waitFor({state:'visible',timeout:180000});
      } catch(err) {await snapshot('publicacao-pendente');throw err;}
      state.uploaded.push(item.id);delete state.uploading;save();
      console.log(`Publicado ${state.uploaded.length}/43: ${item.id}`);
      await page.waitForTimeout(5000);
    }
    console.log('Feed concluido. Stories excluidos da publicacao a pedido do usuario.');
  }
  if(process.argv.includes('--delete')) {
    for (const link of state.inventory.filter(l=>!state.deleted.includes(l))) {
      await page.goto(`https://www.instagram.com${link}`,{waitUntil:'domcontentloaded'});
      await page.getByRole('button',{name:/Mais opções|More options/i}).first().click();
      await page.getByRole('button',{name:/^Excluir$|^Delete$/}).click();
      await page.getByText(/Excluir (publicação|post)|Delete (post|reel)|Excluir reel/i).first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      if (!/Excluir (publicação|post)|Delete (post|reel)|Excluir reel/i.test(await page.locator('body').innerText())) {
        await snapshot('confirmar-exclusao');
        throw new Error('Texto da confirmacao precisa de verificacao');
      }
      state.deleting=link;save();
      await page.getByRole('button',{name:/^Excluir$|^Delete$/}).last().click();
      await page.waitForTimeout(3000);
      const text=await page.locator('body').innerText();
      if (!/exclu[ií]d|deleted/i.test(text) && page.url().includes(link)) {
        await snapshot('resultado-exclusao');throw new Error('Exclusao nao confirmada');
      }
      state.deleted.push(link);delete state.deleting;save();
      console.log(`Excluido ${state.deleted.length}/${state.inventory.length}: ${link}`);
    }
  }
  if(process.argv.includes('--inspect-delete')) {
    await page.goto(`https://www.instagram.com${state.inventory[0]}`,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(3000);
    await snapshot('post');
    const options=page.getByRole('button',{name:/Mais opções|More options/i});
    if(await options.count()) {await options.first().click();await page.waitForTimeout(2000);await snapshot('menu');}
  }
  if(process.argv.includes('--inspect-upload')) {
    await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(2000);
    await snapshot('inicio-criar');
    const create=page.getByRole('link',{name:/^Criar$|^Create$|Nova publicação|New post/i}).or(page.getByRole('button',{name:/^Criar$|^Create$|Nova publicação|New post/i}));
    if(await create.count()) await create.first().click();
    else await page.mouse.click(36,530);
    await page.waitForTimeout(1500);await snapshot('criar');
    const queue=JSON.parse(fs.readFileSync(path.join(ROOT,'..','publicacoes-conta-reserva','fila-publicacao.json'),'utf8'));
    const item=queue.find(r=>r.tipo_original!=='story');
    await page.locator('input[type=file]').setInputFiles(item.arquivos_publicar.map(f=>path.join(ROOT,'..','publicacoes-conta-reserva',f)));
    await page.waitForTimeout(2000);await snapshot('corte');
    await page.getByText(/^Avançar$|^Next$/).first().click();
    await page.waitForTimeout(1000);await snapshot('edicao');
    if(await page.getByText(/^Avançar$|^Next$/).count()) await page.getByText(/^Avançar$|^Next$/).first().click();
    await page.waitForTimeout(1000);await snapshot('legenda');
    console.log(await page.locator('[contenteditable],textarea,input').evaluateAll(es=>es.map(e=>({tag:e.tagName,role:e.getAttribute('role'),aria:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')}))));
  }
} finally {await context.close();}
