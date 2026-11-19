// Todos os textos/rótulos da interface ficam aqui (PT e EN).
// Quando o Instagram mudar algo, este é o primeiro arquivo a ajustar.

export const TEXT = {
  commentOrder: /^(Mais relevantes|Principais comentários|Most relevant|Top comments)$/i,
  newestComments: /^(Mais recentes|Comentários mais recentes|Newest|Newest first|Most recent)$/i,
  reply: /^(Responder|Reply)$/i,
  post: /^(Publicar|Postar|Post)$/i,
  commentInput: /(Adicione um coment[áa]rio|Add a comment)/i,
  loadMore: /(Carregar mais coment[áa]rios|Load more comments|Ver mais coment[áa]rios|View more comments)/i,
  viewReplies: /(Ver|View)\s+(todas as\s+|all\s+)?(\d+\s+)?(mais\s+|more\s+)?(respostas?|repl(y|ies))/i,
  pinned: /(fixad[ao]|pinned)/i,
  notNow: /^(Agora n[ãa]o|Not now)$/i,
  whatHappened: /(O que aconteceu|What happened)/i,
  close: /^(Fechar|Close)$/i,
};

// Qualquer um destes textos visíveis na página faz a execução parar na hora.
export const BLOCK_PATTERNS = [
  /tente novamente mais tarde/,
  /try again later/,
  /a[çc][ãa]o bloqueada/,
  /action blocked/,
  /restringimos (determinadas|certas) atividades/,
  /we restrict certain activity/,
  /temporariamente (bloquead|restrit)/,
  /temporarily (blocked|restricted)/,
  /confirme que [ée] voc[êe]/,
  /confirm (that )?it['’]?s you/,
  /help us confirm/,
  /atividade suspeita/,
  /suspicious (login|activity)/,
  /n[ãa]o sou um rob[ôo]/,
  /i['’]?m not a robot/,
  /captcha/,
  /sua conta foi (suspensa|desativada)/,
  /your account (has been|was) (suspended|disabled)/,
  /n[ãa]o foi poss[íi]vel publicar (o |seu )?coment[áa]rio/,
  /couldn['’]?t post (your )?comment/,
];

// URLs para onde o Instagram redireciona em verificações e bloqueios.
export const BLOCK_URL = /\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled)(\/|\?|$)/i;
