// Cada identificador mantém um perfil de navegador próprio. A janela antiga
// cazetv-1 continua sendo reutilizada para @getv, preservando a sessão.
export const FIVE_PAGE_INSTANCES = ['tntsportsbr-1', 'geglobo-1', 'cazetv-1', 'espnbrasil-1', 'sportv-1'];
// Layout atual: @getv foi removida; não cria mais sua janela.
export const FOUR_PAGE_INSTANCES = FIVE_PAGE_INSTANCES.filter(instance => instance !== 'cazetv-1');
