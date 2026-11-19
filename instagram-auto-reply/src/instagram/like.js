import { checkForBlock } from '../guard.js';
import { extractComments } from './comments.js';
import { humanClick } from '../human.js';

const LIKE = /^(Curtir|Like)$/i;
const UNLIKE = /^(Descurtir|Unlike|Remover curtida)$/i;

// Restringe o clique ao comentario identificado; nunca alterna uma curtida existente.
export async function likeComment(page, comment) {
  await checkForBlock(page);
  await extractComments(page);
  const box = page.locator(`[data-ar-comment="${comment.id}"]`);
  if (await box.count() !== 1) return 'unavailable';
  const unlike = box.getByRole('button', { name: UNLIKE })
    .or(box.getByLabel(UNLIKE, { exact: true }));
  if (await unlike.count()) return 'already-liked';
  const button = box.getByRole('button', { name: LIKE })
    .or(box.getByLabel(LIKE, { exact: true }));
  if (await button.count() !== 1) return 'unavailable';
  await button.scrollIntoViewIfNeeded();
  await humanClick(page, button, { timeout: 5000 });
  await checkForBlock(page);
  try {
    await unlike.first().waitFor({ state: 'visible', timeout: 5000 });
    return 'liked';
  } catch {
    return 'unknown';
  }
}
