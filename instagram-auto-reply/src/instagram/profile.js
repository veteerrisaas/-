import { IG_URL, dismissPopups } from '../browser.js';
import { checkForBlock } from '../guard.js';
import { sleep } from '../human.js';
import { TEXT } from '../selectors.js';

/** Retorna os N posts mais recentes da grade do perfil: [{ code, url, pinned }]. */
export async function getRecentPosts(page, username, count, skipPinned) {
  await page.goto(`${IG_URL}${username}/`, { waitUntil: 'domcontentloaded' });
  await checkForBlock(page);
  await dismissPopups(page);
  await page.locator('main a[href*="/p/"], main a[href*="/reel/"]').first().waitFor({ timeout: 30_000 });

  let posts = [];
  for (let scroll = 0; scroll < 6; scroll++) {
    posts = await page.evaluate((pinnedSrc) => {
      const pinnedRe = new RegExp(pinnedSrc, 'i');
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('main a[href]')) {
        // Aceita /p/CODE/, /reel/CODE/ e /usuario/p/CODE/
        const m = (a.getAttribute('href') || '').match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const labels = [...a.querySelectorAll('svg[aria-label], [aria-label]')].map((el) => el.getAttribute('aria-label'));
        out.push({
          code: m[1],
          url: new URL(a.getAttribute('href'), location.origin).href,
          pinned: labels.some((l) => pinnedRe.test(l || '')),
        });
      }
      return out;
    }, TEXT.pinned.source);

    if (posts.filter((p) => !skipPinned || !p.pinned).length >= count) break;
    await page.mouse.wheel(0, 1500);
    await sleep(1500);
  }

  return posts.filter((p) => !skipPinned || !p.pinned).slice(0, count);
}
