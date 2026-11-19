import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devices } from 'playwright';
import { openBrowser } from '../src/browser.js';
import { BrowserReadFallback, RetryInBrowserMode } from '../src/mobile-fallback.js';
import { BlockedError, CommentsUnavailableError, ReplyReadLimitedError, PageUnavailableError } from '../src/guard.js';
import { Store } from '../src/store.js';

const target = { post: { url: 'https://www.instagram.com/tntsportsbr/p/TEST/' },
  profile: { username: 'tntsportsbr' }, username: 'golsdodia.galo', enabled: true, browserMode: 'desktop' };

for (const [username, nextModes] of [
  ['golsdodia.galo', ['mobile', 'iphone', 'desktop']],
  ['gabrieldastip', ['mobile', 'iphone', 'desktop']],
  ['gbrdastip', ['mobile', 'iphone', 'desktop']],
  ['gabrieldastips', ['mobile', 'iphone', 'desktop']],
  ['gbrdastips', ['mobile', 'iphone', 'desktop']],
  ['correa.tipss', ['mobile', 'iphone', 'desktop']],
  ['golsdodia.cabuloso', ['mobile', 'desktop']],
]) {
test(`interfaces alternam repetidamente na ${username}, mantendo o mesmo post e uma espera crescente`, () => {
  const fallback = new BrowserReadFallback();
  const error = new ReplyReadLimitedError('Rate limit');
  let browserMode = 'desktop';
  for (let failure = 0; failure < 12; failure++) {
    const expectedMode = nextModes[failure % nextModes.length];
    assert.throws(() => fallback.request(error, { ...target, username, browserMode }), (request) => {
      assert.ok(request instanceof RetryInBrowserMode);
      assert.equal(request.post, target.post);
      assert.equal(request.profile, target.profile);
      assert.equal(request.cause, error);
      assert.equal(request.browserMode, expectedMode);
      assert.equal(request.waitMs, failure === 0 ? 0 : Math.min(1_800_000, 30_000 * 2 ** (failure - 1)));
      return true;
    });
    browserMode = expectedMode;
  }
});
}

test('leitura concluída reinicia a espera e outra janela mantém seu próprio estado', () => {
  const first = new BrowserReadFallback();
  const second = new BrowserReadFallback();
  const error = new CommentsUnavailableError('sem comentários');
  assert.throws(() => first.request(error, target), RetryInBrowserMode);
  assert.throws(() => first.request(error, { ...target, browserMode: 'mobile' }), (retry) => retry.waitMs === 30_000);
  assert.throws(() => second.request(error, target), (retry) => retry.waitMs === 0);
  first.succeeded();
  assert.throws(() => first.request(error, { ...target, browserMode: 'mobile' }),
    (retry) => retry.browserMode === 'iphone' && retry.waitMs === 0);
});

test('outras contas, modo desconhecido e opção desativada não alternam interfaces', () => {
  const fallback = new BrowserReadFallback();
  const error = new ReplyReadLimitedError('Rate limit');
  for (const username of ['unknown_account', 'golsdodia.colorado', undefined]) {
    assert.doesNotThrow(() => fallback.request(error, { ...target, username }));
  }
  assert.doesNotThrow(() => fallback.request(error, { ...target, enabled: false }));
  assert.doesNotThrow(() => fallback.request(error, { ...target, browserMode: 'unknown' }));
  assert.doesNotThrow(() => fallback.request(error, { ...target, username: 'golsdodia.cabuloso', browserMode: 'iphone' }));
  assert.equal(fallback.failures, 0);
});

test('captcha, HTTP de navegação e erro de envio não disparam a troca de interface', () => {
  const fallback = new BrowserReadFallback();
  for (const error of [new BlockedError('captcha'), new PageUnavailableError('HTTP 429'), new Error('envio incerto')]) {
    assert.doesNotThrow(() => fallback.request(error, target));
  }
  assert.equal(fallback.failures, 0);
});

test('desktop → Android → iPhone → desktop preserva login, armazenamento e reservas sem acessar Instagram', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mobile-fallback-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  const dataPath = path.join(temporaryRoot, 'replied.json');
  let session;
  try {
    const store = new Store(dataPath, { report: false });
    const pending = '18133313581739732';
    const sent = '18133313581739733';
    assert.equal(store.markPending(pending, { author: 'viewer' }), true);
    assert.equal(store.markPending(sent, { author: 'another_viewer' }), true);
    store.markSent(sent);
    const historyBefore = fs.readFileSync(dataPath, 'utf8');
    const fixture = async (route) => route.fulfill({ contentType: 'text/html', body: '<main>Local fixture</main>' });
    session = await openBrowser({ headless: true, profilePath, browserMode: 'desktop' });
    await session.context.route('**/*', fixture);
    await session.context.addCookies([{ name: 'sessionid', value: 'fixture-session',
      domain: 'fallback.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await session.page.goto('https://fallback.test/');
    assert.doesNotMatch(await session.page.evaluate(() => navigator.userAgent), /Android/);
    await session.page.evaluate(() => localStorage.setItem('test-account', 'golsdodia.galo'));
    await session.context.close();

    session = await openBrowser({ headless: true, profilePath, browserMode: 'mobile' });
    await session.context.route('**/*', fixture);
    await session.page.goto('https://fallback.test/');
    const device = await session.page.evaluate(() => ({ ua: navigator.userAgent,
      touch: navigator.maxTouchPoints, account: localStorage.getItem('test-account') }));
    assert.match(device.ua, /Android/);
    assert.ok(device.touch > 0);
    assert.equal(device.account, 'golsdodia.galo');
    assert.deepEqual(session.page.viewportSize(), devices['Pixel 7'].viewport);
    assert.equal((await session.context.cookies('https://fallback.test/')).find((c) => c.name === 'sessionid')?.value, 'fixture-session');
    await session.context.close();

    session = await openBrowser({ headless: true, profilePath, browserMode: 'iphone' });
    await session.context.route('**/*', fixture);
    await session.page.goto('https://fallback.test/');
    const iphone = await session.page.evaluate(() => ({ ua: navigator.userAgent,
      touch: navigator.maxTouchPoints, account: localStorage.getItem('test-account') }));
    assert.match(iphone.ua, /iPhone/);
    assert.doesNotMatch(iphone.ua, /Android/);
    assert.ok(iphone.touch > 0);
    assert.equal(iphone.account, 'golsdodia.galo');
    assert.deepEqual(session.page.viewportSize(), devices['iPhone 13'].viewport);
    assert.equal((await session.context.cookies('https://fallback.test/')).find((c) => c.name === 'sessionid')?.value, 'fixture-session');
    assert.equal(fs.readFileSync(dataPath, 'utf8'), historyBefore);
    await session.context.close();

    session = await openBrowser({ headless: true, profilePath, browserMode: 'desktop' });
    await session.context.route('**/*', fixture);
    await session.page.goto('https://fallback.test/');
    assert.doesNotMatch(await session.page.evaluate(() => navigator.userAgent), /Android/);
    assert.equal(await session.page.evaluate(() => navigator.maxTouchPoints), 0);
    assert.equal(await session.page.evaluate(() => localStorage.getItem('test-account')), 'golsdodia.galo');
    assert.equal((await session.context.cookies('https://fallback.test/')).find((c) => c.name === 'sessionid')?.value, 'fixture-session');
    assert.equal(fs.readFileSync(dataPath, 'utf8'), historyBefore);
    assert.equal(new Store(dataPath, { report: false }).markPending(pending, {}), false);
    assert.equal(new Store(dataPath, { report: false }).markPending(sent, {}), false);
  } finally {
    await session?.context.close();
    const resolved = path.resolve(temporaryRoot);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
      || !path.basename(resolved).startsWith('ig-mobile-fallback-')) throw new Error('Pasta temporária inesperada');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
