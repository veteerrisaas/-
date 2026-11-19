const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[‍️⃣\s])+$/u;
const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** true para comentários como "😍🔥" ou "👏🏽 👏🏽"; false para texto, números ou vazio. */
export function isEmojiOnly(text) {
  const t = (text || '').trim();
  return Boolean(t) && EMOJI_ONLY.test(t) && HAS_EMOJI.test(t);
}

export function pickMessage(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

/** Não envia publicidade automática a comentários com intenção explícita de autoagressão. */
export function isSelfHarmComment(text) {
  const normalized = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\b(?:vou|quero|pretendo|penso em)\s+(?:me\s+suicidar|me\s+matar|tirar\s+(?:a\s+)?minha\s+vida)\b/.test(normalized)
    || /\b(?:i\s+(?:want to|will|am going to)|i['’]m going to)\s+(?:kill myself|end my life)\b/.test(normalized);
}
