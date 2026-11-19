# Instagram Auto Reply

Para retomar o projeto em uma nova sessão, leia primeiro [CONTEXTO-OPERACIONAL.md](CONTEXTO-OPERACIONAL.md), que reúne a lógica atual e os cuidados de operação.

Responde automaticamente aos comentários dos seus posts mais recentes no Instagram. O script usa a interface web por meio do Playwright, sem a API da Meta.

> **Atenção:** os Termos de Uso do Instagram não permitem automação pela interface web. Mesmo com limites baixos e pausas aleatórias, o Instagram pode bloquear ações temporariamente ou pedir verificação da conta. Use limites conservadores. O script para sozinho ao primeiro sinal de bloqueio.

## Como funciona

Os quatro destinos ativos são **@tntsportsbr, @ge.globo, @espnbrasil e @sportv**, cada um em sua própria janela. **@getv está desativada.** O inicializador usa `--four`, prepara a sessão para as quatro janelas e confere três posts recentes por página. Os limites preexistentes de duas respostas por perfil/ciclo são preservados para ge.globo, espnbrasil e sportv. Os identificadores são `tntsportsbr-1`, `geglobo-1`, `espnbrasil-1` e `sportv-1`. O alias legado `cazetv-1` aponta para ge.globo nos modos antigos, mas não é aberto pelo layout atual. Histórico, banco de mensagens, intervalo por conta e filtro de luto continuam compartilhados. Todas as janelas precisam confirmar o login antes de enviar; a troca de modo aguarda o encerramento de todas. O mapeamento `instanceTargets` aceita um destino único ou uma lista; destinos inválidos, repetidos no mesmo grupo ou inativos impedem a inicialização.

### Publicações de luto

Antes de abrir comentários, o sistema confere a legenda e o texto acessível das imagens do post exato. Falecimento, luto, condolências e homenagens póstumas fazem a publicação inteira ser pulada, com o motivo no log. O post `DfibQK8jYr3` está bloqueado explicitamente. Se não houver legenda legível para fazer a avaliação, o post também é pulado. Comentários de terceiros e metadados de outras publicações não são usados nessa decisão. Expressões esportivas como “grupo da morte” e “morte súbita” não bloqueiam por si só. O filtro usa regras de texto; não executa OCR e pode deixar de reconhecer uma homenagem sem termos identificáveis. Rode `npm run test:post-safety` para validar o comportamento sem publicar nada.

### Banco de mensagens e intervalo atual

Neste ambiente, `config.json` ativa `messageBank`. A lista `zeroActionDelaysFor` inclui **gbrdastip**: essa conta usa pausas zero entre mensagens, posts, cliques, caracteres digitados e ciclos. O inicializador também desativa as pausas genéricas para essa conta, e o temporizador compartilhado não espera outra janela quando o intervalo é zero. Outras contas mantêm os valores padrão de `delays` (15 a 20 segundos entre respostas). Permanecem as esperas necessárias de carregamento, validações e as pausas por erros ou restrições. O histórico, a reserva de textos únicos e os limites dos perfis continuam ativos. Não existe garantia de envios simultâneos: rede, interface e gravações atômicas ainda podem levar tempo.

O banco local `data/messages.sqlite` importa os textos de todos os arquivos `data/replied*.json`, incluindo pendentes. Cada novo texto é reservado de forma atômica antes de preparar o envio, independentemente da conta ou janela. A menção inicial, acentos, pontuação e emojis são ignorados na comparação. Uma reserva não é liberada após falhas, evitando reutilização de envios incertos.

Os modelos originais em `config.json` e `profiles.json` são preservados, mas só podem ser usados se atenderem às regras atuais: abertura com uma palavra em maiúsculas seguida de exclamação e no máximo **100 caracteres**, incluindo emojis e excluindo a menção ao destinatário. O sistema combina as listas de `message-templates.json`, mantendo o objetivo de encaminhar aos stories, sem adicionar promessas de ganhos. A estrutura curta atual contém **50.000 combinações de texto**: 20 aberturas de impacto, 50 perguntas e 50 chamadas para os stories, sem uma segunda chamada no final. Todas foram verificadas quanto ao comprimento e à unicidade após normalização. O total disponível diminui conforme os textos são reservados; as 960 combinações anteriores fazem parte deste catálogo ampliado e continuam protegidas pelo histórico. São variações do mesmo conteúdo promocional, não assuntos diferentes. Ao esgotar os textos inéditos, a instância interrompe os envios; não recicla frases nem acrescenta números aleatórios. Amplie as listas de frases para disponibilizar novas combinações. Mensagens selecionadas mas não enviadas também ficam consumidas por segurança.

Requer Node.js 24 ou superior, já disponível neste ambiente. Execute `npm run messages:prepare` para importar o histórico e ver exemplos sem enviar mensagens. Execute `npm run test:messages` para verificar concorrência, persistência e intervalos. O modo `--dry-run` usa um banco em memória e não consome textos no banco persistente. Reinicie todas as instâncias após atualizar o código; processos antigos não passam a usar o banco automaticamente. Preserve o banco e os arquivos de histórico nos backups; não apague o SQLite para liberar mensagens.

A expansão agora é feita por conversa: primeiro são carregados os comentários principais; antes de responder a um deles, o programa tenta abrir somente as respostas daquele comentário quando necessário para conferir as contas excluídas. A coleta inicial não expande mais todas as conversas do post.

Com `loadAllComments: true`, o carregamento percorre a lista, tenta expandir respostas e guarda os IDs encontrados até três passagens sem novos IDs. O limite `maxLoadMore` deixa de limitar esse modo. Falhas anteriores à tentativa de envio são registradas por comentário e não abandonam automaticamente o restante do post. Comentários da própria conta também aparecem no log com o motivo da exclusão. Envios incertos continuam protegidos contra repetição. Isso amplia a cobertura dos comentários entregues pela interface, sem garantir acesso a todos os comentários existentes ou aceitação de todos os envios pelo Instagram.

1. Abre o seu perfil e pega os **N posts mais recentes** (padrão: 5).
2. Em cada post, carrega mais comentários e expande as respostas.
3. Pula um comentário quando:
   - contém intenção explícita de autoagressão, para não receber uma resposta promocional automática;
   - ele é de `@gabrieltipss`, `@gabrieldastip`, `@golsdodia.colorado` ou `@golsdodia.galo`, ou tem uma resposta carregada de uma dessas contas;
   - ainda há respostas fechadas na conversa, ou o comentário não pode ser localizado para conferência;
   - o comentário é seu;
   - o autor tem mais de um comentário principal entre os comentários carregados do mesmo post; respostas e leituras repetidas do mesmo ID não entram na contagem;
   - ele já está no registro local (`data/replied.json`);
   - já existe uma resposta sua nele;
   - ele tem só emoji (se você ativou essa opção).
4. Nos demais, clica em **Responder/Reply**, confirma o estado **Respondendo a/Replying to**, preenche uma das mensagens configuradas e envia. A requisição precisa conter o ID do comentário pai correto; sem esse vínculo, a publicação é bloqueada localmente e o serviço para. Uma menção `@usuario` sozinha nunca autoriza o envio.
5. Espera o intervalo de `delays.betweenRepliesSec` entre respostas (8 a 12 s neste ambiente) e respeita os limites por execução e por dia.

### Garantia de não responder duas vezes

O comentário é gravado no registro como `pending` **antes** do clique em enviar. Depois que a resposta é confirmada, ele passa para `sent`. Um comentário em `pending` nunca é tentado de novo. Se a interface falhar no meio do envio, o pior que acontece é aquele comentário ficar sem resposta. Os casos em `pending` aparecem como aviso no log de cada execução, para você conferir manualmente.

## Requisitos

Para encerrar em um horário fixo, o inicializador aceita `--stop-at 2026-11-09T23:00:00-03:00`. A data e o fuso são obrigatórios; o limite inclui todas as retomadas do serviço e encerra sua árvore de processos. Não combine com `--duration-minutes`. O horário precisa estar nas próximas 24 horas e é conferido novamente após preparar o login.

Para iniciar somente a conta nova @gbrdastip, use `npm run watch:2:gbrdastip` (`-- --check` para validar sem executar). O inicializador usa a sessão manual em `browser-profile-manual-gbrdastip`, confere o acesso ao perfil antes de preparar duas sessões isoladas e começa no desktop. A alternância sincronizada é desktop → Android → iPhone → desktop quando as condições de troca do fluxo existente ocorrerem. Não há troca por tempo fixo. O `.env` e os perfis das outras contas são preservados; histórico e banco de mensagens permanecem compartilhados.

- Node.js 24 ou mais recente (`node --version`)
- Windows, macOS ou Linux com interface gráfica (o navegador roda visível por padrão)

## Instalação

```bash
cd instagram-auto-reply
npm install
npm run setup          # baixa o Chromium do Playwright
```

Crie os arquivos de configuração a partir dos exemplos:

```bash
# Linux/Mac
cp .env.example .env
cp config.example.json config.json

# Windows (PowerShell)
Copy-Item .env.example .env
Copy-Item config.example.json config.json
```

Edite o `.env`:

```ini
IG_USERNAME=seu_usuario   # sem @
DRY_RUN=true              # comece sempre em dry run
HEADLESS=false            # navegador visível
```

Edite o `config.json`:

| Campo | O que faz | Padrão |
|---|---|---|
| `messages` | Uma ou mais variações da mensagem. Uma delas é sorteada a cada resposta. | – |
| `mentionUser` | Inclui `@usuario` de quem comentou (o próprio Instagram já preenche ao clicar em Responder). Com `false`, a menção é apagada, e o Instagram pode publicar o texto como comentário comum, fora da thread. | `true` |
| `postsToCheck` | Quantos posts recentes verificar | `5` |
| `minPostComments` | Total mínimo de comentários exibido no post. Contagem desconhecida ou abaixo do mínimo faz o post ser ignorado. | `30` |
| `skipPinned` | Ignora posts fixados no topo do perfil | `false` |
| `maxLoadMore` | Quantas vezes clicar em "Carregar mais comentários" por post | `5` |
| `ignoreEmojiOnly` | Ignora comentários que têm só emoji | `true` |
| `activeHours` | Horário de funcionamento `[início, fim]`, em horas. Fora dele o serviço fica parado. Ex.: `[9, 24]` funciona das 9h à meia-noite. | `[0, 24]` |
| `maxCommentAgeMin` | Só responde comentários feitos há no máximo X minutos (`0` = sem filtro) | `0` |
| `limits.maxPerRun` | Máximo de respostas por execução | `10` |
| `limits.maxPerDay` | Máximo de respostas por dia (conta todas as execuções do dia) | `20` |
| `delays.betweenRepliesSec` | Pausa aleatória entre respostas `[min, max]`, em segundos | `[20, 60]` |
| `delays.betweenPostsSec` | Pausa aleatória entre posts, em segundos | `[5, 15]` |
| `delays.typingMsPerChar` | Atraso por caractere digitado, em ms | `[40, 160]` |

## Em quais perfis responder (`profiles.json`)

Por padrão, o script responde aos comentários dos posts do **seu próprio perfil** (`IG_USERNAME`). Para escolher em quais perfis ele responde, crie o `profiles.json`:

```bash
# Linux/Mac
cp profiles.example.json profiles.json
# Windows (PowerShell)
Copy-Item profiles.example.json profiles.json
```

```json
{
  "profiles": [
    { "username": "seu_usuario", "enabled": true },
    { "username": "outro_perfil", "enabled": true, "postsToCheck": 3, "maxPerRun": 5,
      "messages": ["Obrigado pelo comentário! 💙", "Que bom que você gostou!", "Valeu pelo carinho!"] },
    { "username": "perfil_pausado", "enabled": false }
  ]
}
```

- **Quem responde** é sempre a conta logada (`IG_USERNAME`). Os perfis da lista dizem **em quais posts** ela responde.
- Os perfis são verificados na ordem da lista. Para pausar um perfil sem apagá-lo, use `"enabled": false`.
- Campos opcionais por perfil: `messages` (uma ou mais variações), `postsToCheck`, `skipPinned` e `maxPerRun`. O que não for informado vem do `config.json`.
- O `maxPerDay` do `config.json` vale para **todos os perfis somados**.
- Cada resposta fica registrada em `data/replied.json` com o campo `"profile"`, que indica em qual perfil ela foi feita. O log também mostra o perfil.
- Em perfil de outra pessoa, a conta logada precisa conseguir comentar nos posts. Perfis privados que você não segue, ou com comentários restritos, geram erro no log, e o script segue para o próximo perfil.
- Responder em massa em perfis de terceiros chama mais a atenção do sistema antispam do Instagram. Mantenha limites ainda mais baixos nesses perfis.

## Primeiro login

O modo do navegador é controlado por `browserMode` no `config.json`: `desktop` usa o layout com comentários dentro do post; `mobile` emula o Pixel 7 e `iphone` emula o iPhone 13, com tela, identificação e toque emulados no Chromium. Isso não transforma o navegador no aplicativo Instagram ou em um iPhone físico. A opção `--browser-mode desktop|mobile|iphone` sobrescreve o modo apenas naquela execução. A configuração atual usa `desktop`. As sessões existentes são preservadas. No desktop, a confirmação inicial usa a menção preenchida pelo clique em Responder; a proteção de rede ainda exige o ID pai correto.

### Quatro instâncias com sessões separadas

Use `npm run browser:caze1`, `npm run browser:caze2`, `npm run browser:tnt1` e `npm run browser:tnt2` para abrir as quatro sessões e entrar na mesma conta configurada em `IG_USERNAME`. Cada sessão tem uma pasta própria `browser-profile-<perfil>-<número>/`. Feche as janelas de ajuste antes de iniciar os comandos `npm run watch:caze1`, `npm run watch:caze2`, `npm run watch:tnt1` e `npm run watch:tnt2`, cada um em um terminal separado.

As instâncias 1 verificam os posts nas posições 1, 3, 5...; as instâncias 2 verificam os posts 2, 4, 6..., dentro de `postsToCheck` de cada página. Com três posts configurados, uma instância verifica dois e a outra um. A cota de 45 por página é dividida em 23 para a instância 1 e 22 para a instância 2, por ciclo de cada instância. Os ciclos são independentes. Não rode também `npm run watch` na sessão antiga.

As quatro instâncias compartilham `data/replied.json`: antes de publicar, uma trava de arquivo reserva o ID do comentário e verifica o limite diário total. O histórico é relido antes de cada alteração para impedir sobrescrita por outro processo. Uma trava ocupada impede novos envios. Pare e reinicie todas as execuções antigas ao atualizar o código do registro.

Para iniciar as quatro no mesmo terminal, use `npm run watch:all`. Os logs identificam a instância entre colchetes. `Ctrl + C` encerra as quatro; se uma instância parar por erro ou restrição, o inicializador encerra as demais. Não execute os comandos individuais ao mesmo tempo que `watch:all`. `npm run watch:all -- --check` valida a configuração sem iniciar navegadores.

O aviso HTTP ERROR 429 visível na tela interrompe a execução. A resposta HTTP 429 de rede, inclusive na navegação da página principal, não encerra automaticamente o navegador. HTTP 429 no envio interno mantém a instância aberta, preserva o envio como pendente e pausa 60 segundos sem repetir a mensagem. As demais proteções de bloqueio continuam ativas.

As instâncias navegam de forma independente, sem fila compartilhada de abertura de páginas. A trava do registro coordena somente as reservas e gravações de comentários para evitar duplicatas.

Para abrir somente o Instagram em modo mobile e ajustar a conta manualmente, execute `npm run browser` (ou `npm run browser -- --reserve` para a conta reserva). A janela permanece aberta até você fechá-la; esse comando não inicia o auto-reply. O login feito nessa janela fica salvo no mesmo perfil usado pela automação. Feche a janela antes de iniciar outro comando que use esse perfil.

No mobile, o auto-reply abre a página completa de comentários antes da leitura. Como as datas não contêm links com IDs nessa interface, a extração usa as chaves originais dos componentes React e os links de curtidas para conferir os IDs disponíveis. Essa estrutura interna pode mudar; comentários sem identificação estável são ignorados, e uma lista visível sem IDs reconhecidos gera uma falha de carregamento.

Cada envio sorteia uma mensagem de forma independente, com a mesma chance para cada opção. Não há alternância obrigatória: a mesma mensagem pode sair várias vezes seguidas.

`quietHours: false` desativa a pausa noturna. Para ativá-la, use um intervalo como `quietHours: [3, 7]`, que suspende novos envios e curtidas diariamente das 03:00 às 07:00, no fuso `America/Sao_Paulo`. A verificação ocorre também antes do clique de envio, inclusive durante um ciclo. Às 07:00 o processo pode continuar automaticamente; a pausa noturna reinicia a contagem da pausa periódica.

Depois de uma resposta enviada (confirmada ou não verificada), outro sorteio decide se o comentário também será curtido. Configure `"likeProbability": 0.3` no `config.json` para 30% de chance; `0` desativa e `1` curte todos os comentários respondidos elegíveis. O sorteio é independente da mensagem e não garante uma quantidade exata de curtidas. Comentários já curtidos são preservados; se o botão não for identificado com segurança ou o resultado ficar incerto, o clique não é repetido. No modo `--dry-run`, a decisão aparece no log e nenhuma curtida é enviada.

```bash
npm run login
```

O navegador abre no Instagram em modo mobile Android (Pixel 7), com identificação do navegador, tela e toque emulados pelo Playwright. O login e o auto-reply usam essa mesma configuração, inclusive para a conta reserva. Isso emula um navegador mobile; não garante que o Instagram reconheça um aparelho físico ou o aplicativo Android.

Faça login normalmente, incluindo o 2FA. O script detecta quando o login foi concluído e fecha o navegador sozinho (o tempo máximo de espera é 5 minutos). Se uma conta já estiver conectada e você quiser entrar novamente, use `npm run login -- --reauth`. Esse comando remove o cookie de sessão anterior; na tela do Instagram, escolha a conta desejada. Para a conta reserva, use `npm run login:reserve -- --reauth`.

A sessão fica salva na pasta `browser-profile/`. **Sua senha nunca é lida nem salva pelo script.** Trate essa pasta como uma senha: não compartilhe e não envie para o Git (ela já está no `.gitignore`).

Se a sessão expirar, a execução normal para com o código de saída 3 e a mensagem pedindo `npm run login`.

## Testar com dry run

Para desativar os limites de quantidade, use `false` em `limits.maxPerRun` e `limits.maxPerDay` no `config.json` e em `maxPerRun` dos perfis ativos no `profiles.json`. Isso preserva as pausas, filtros e divisão de posts. Valores inteiros continuam disponíveis para reativar os limites.

```bash
npm run dry
```

Ou deixe `DRY_RUN=true` no `.env` e rode `npm start`. Nesse modo o script percorre os posts e comentários e registra no log o que responderia, sem clicar em Responder e sem gravar nada no registro:

```
[2026-10-10 15:02:11] DRY     responderia @maria (17912345678901234) "amei esse look!" com: "@maria Valeu demais pelo carinho!"
```

Confira o log e, se estiver tudo certo, troque para `DRY_RUN=false` e rode:

```bash
npm start
```

Acompanhe a primeira execução real com o navegador aberto.

## Modo contínuo (como serviço)

```bash
npm run watch
```

O script fica rodando sem parar:

1. Faz um ciclo completo, passando pelos perfis na ordem e respondendo os comentários novos dos posts mais recentes.
2. Espera um intervalo aleatório (`watch.intervalMin` no `config.json`, padrão de 15 a 30 minutos, mínimo de 10 segundos). O valor `0.16666666666666666` corresponde a 10 segundos; valores fracionários são aceitos.
3. Começa outro ciclo, e assim por diante.

Detalhes:

- O navegador fica aberto entre os ciclos.
- O `config.json` e o `profiles.json` são lidos de novo a cada ciclo, então você pode editá-los sem reiniciar o serviço.
- Quando o `maxPerDay` é atingido, o serviço fica parado até o dia seguinte (entre 0h10 e 1h) e depois volta sozinho.
- O serviço **para de vez** quando aparece bloqueio, captcha ou verificação (código 2), quando a sessão expira (código 3), após três envios consecutivos sem confirmação, ou depois de 5 ciclos seguidos com erro. Um envio isolado sem confirmação fica pendente, não é repetido e o ciclo segue para o próximo post. Respostas aceitas reiniciam a contagem de envios incertos. HTTP 403 ou 429 no envio também interrompem o serviço.
- Para encerrar, aperte `Ctrl+C`.
- `watch.workSessionMin` (padrão 20) e `watch.breakMin` (padrão `[4, 10]`) definem a pausa periódica. Antes de um novo envio ou post, ao completar 20 minutos de execução, o serviço sorteia uma duração entre 4 e 10 minutos, incluindo segundos. Cada pausa tem um novo sorteio independente. A contagem atravessa os ciclos e reinicia depois da pausa. Um número em `breakMin` continua sendo aceito para uma duração fixa.
- A mensagem “Não é possível carregar os comentários” recebe tratamento de falha de carregamento: espera de 30 segundos e uma única recarga do post. Se persistir, o post é ignorado; três falhas consecutivas encerram o serviço. Avisos de bloqueio, captcha e “Tente novamente mais tarde” fora desse contexto continuam interrompendo imediatamente. Se a falha surgir após um clique de envio, o registro permanece pendente e não é repetido.

Para iniciar sozinho quando você entra no Windows, use `run-watch.cmd` no Agendador de Tarefas com o disparador **"Ao fazer logon"**. Não configure para reiniciar automaticamente em caso de falha: se o serviço parou por bloqueio, ele precisa ficar parado.

```powershell
schtasks /Create /TN "Instagram Auto Reply" /TR "'C:\caminho\para\instagram-auto-reply\run-watch.cmd'" /SC ONLOGON /IT
```

## Relatório de acompanhamento

O arquivo `relatorio-respostas.csv` (na pasta do projeto) é atualizado sozinho a cada resposta e abre no Excel. Cada linha é uma resposta, com estas colunas:

- quando foi respondido;
- perfil (página);
- link do post;
- link do comentário;
- quem comentou e o que comentou;
- quando foi comentado;
- resposta enviada;
- status: `enviado`, `enviado (não verificado)` ou `pendente`.

As respostas mais recentes ficam no topo. Se o arquivo estiver aberto no Excel na hora de uma resposta, ele não é atualizado naquele momento: o log mostra um aviso, e o arquivo é atualizado de novo na resposta seguinte. Para gerar o relatório manualmente, rode `npm run report`.

Em cada post, os comentários mais recentes são respondidos primeiro. Quando disponível, o serviço seleciona “Mais recentes” na interface antes de carregar os comentários; em seguida, ordena os comentários carregados pela data. Datas ausentes ou inválidas ficam no fim. O `config.json` deste projeto usa `skipPinned: true` para ignorar posts fixados e verificar os primeiros posts não fixados da grade, na ordem do perfil. Cada perfil pode sobrescrever essa opção.

## Arquivos gerados

| Pasta/arquivo | Conteúdo |
|---|---|
| `browser-profile/` | Sessão do navegador |
| `data/replied.json` | Registro dos comentários respondidos (não apague, porque é ele que evita respostas duplicadas) |
| `logs/AAAA-MM-DD.log` | Log de cada dia |
| `screenshots/` | Capturas tiradas em erros e bloqueios |

## Códigos de saída

| Código | Significado |
|---|---|
| 0 | OK (ou limite diário já atingido) |
| 1 | Erro inesperado (veja o log e o screenshot) |
| 2 | **Bloqueio, captcha ou "tente novamente mais tarde" detectado.** Espere pelo menos 24 h antes de rodar de novo. |
| 3 | Sem sessão; rode `npm run login` |

## Agendamento

Sugestão: de 1 a 3 execuções por dia, em horários diferentes. O limite diário vale para todas as execuções somadas.

### Windows: Agendador de Tarefas

1. Abra o **Agendador de Tarefas** e clique em **Criar Tarefa...** (não use "Criar Tarefa Básica").
2. Na aba **Geral**:
   - Nome: `Instagram Auto Reply`
   - Marque **"Executar somente quando o usuário estiver conectado"**. Isso é necessário para o navegador visível aparecer.
3. Na aba **Disparadores**, clique em **Novo** e escolha **Diariamente**, por exemplo às 10:00. Crie outro disparador às 18:00 se quiser.
   - Opcional: marque "Atrasar a tarefa aleatoriamente por" 30 minutos.
4. Na aba **Ações**, clique em **Novo** e preencha:
   - Programa/script: `C:\caminho\para\instagram-auto-reply\run.cmd`
   - Iniciar em: `C:\caminho\para\instagram-auto-reply`
5. Na aba **Configurações**, marque "Interromper a tarefa se ela for executada por mais de" **1 hora**.
6. Clique em OK. Para testar, clique com o botão direito na tarefa e escolha **Executar**.

Pelo PowerShell, o equivalente seria:

```powershell
schtasks /Create /TN "Instagram Auto Reply" /TR "C:\caminho\para\instagram-auto-reply\run.cmd" /SC DAILY /ST 10:00 /IT
```

### Linux/Mac: cron

```bash
chmod +x run.sh
crontab -e
```

Adicione, por exemplo, uma execução às 10:15 e outra às 18:40:

```cron
15 10 * * * /caminho/para/instagram-auto-reply/run.sh >> /caminho/para/instagram-auto-reply/logs/cron.log 2>&1
40 18 * * * /caminho/para/instagram-auto-reply/run.sh >> /caminho/para/instagram-auto-reply/logs/cron.log 2>&1
```

Observações:

- O cron roda com um `PATH` reduzido. Se o `node` não for encontrado, troque `exec node` por `exec /caminho/completo/do/node` dentro do `run.sh` (para ver o caminho, rode `which node`).
- **Linux:** para usar o navegador visível, a tarefa precisa saber qual tela usar. Adicione `DISPLAY=:0` antes do comando no crontab. Em servidor sem interface gráfica, use `HEADLESS=true` no `.env`.
- **macOS:** pode ser preciso dar "Acesso Total ao Disco" ao `cron` em Ajustes do Sistema > Privacidade e Segurança. Outra opção é usar `launchd`.

## Conversas excluídas

Publicações em collab são ignoradas antes de carregar ou responder aos comentários. O filtro confere os coautores do post atual; menções na legenda, marcações e autores de comentários não contam como collab. Se não for possível confirmar a autoria, o post também é pulado. Essa regra vale para todas as contas nos modos desktop, Android e iPhone.

As contas `gabrieltipss`, `gabrieldastip`, `golsdodia.colorado` e `golsdodia.galo`, além das contas configuradas no `.env`, são excluídas em qualquer conta ativa. O serviço ignora comentários escritos por essas contas e conversas em que alguma delas já respondeu, incluindo respostas aninhadas e respostas lidas anteriormente que saíram da tela.

A identificação dos links aceita o selo de verificado e endereços completos com parâmetros. A verificação usa os elementos atuais da conversa e é repetida antes de selecionar a resposta e imediatamente antes de publicar, depois da reserva no histórico compartilhado. Autor incerto, conversa não identificada ou leitura de respostas incompleta impedem o envio. Uma menção no texto ou um comentário da conta excluída em outra conversa não excluem o comentário atual.

Ao expandir respostas, a consulta observada deve apontar para o ID exato daquele comentário. Se o servidor confirmar uma lista vazia e o fim da paginação, um contador antigo de “Ver respostas” pode ser desconsiderado; as demais regras continuam sendo verificadas. Os autores retornados pela consulta são conferidos mesmo quando o texto da resposta não aparece na interface. Erros, limite de leitura, resposta desconhecida, paginação restante ou autor desconhecido não são tratados como lista vazia. A confirmação vale apenas para a página e os controles conferidos; recarregar ou mudar o contador exige nova leitura.

Execute `npm run test:threads` para validar essa proteção em páginas simuladas, incluindo a conta ativa `golsdodia.galo`, mudanças durante a reserva e ausência de publicações nas conversas excluídas.

## Terceira conta

Defina `IG_THIRD_USERNAME` no `.env`, com o usuário da terceira conta sem `@` (atualmente `golsdodia.cabuloso`). Para conectá-la, execute `npm run login:account3` e aguarde a confirmação de login e o fechamento da janela. Para abrir somente o navegador dessa conta, use `npm run browser:account3`.

Para rodar somente com a terceira conta nas duas páginas, sem trocar para outras contas, use `npm run watch:2:account3`. Esse comando prepara o login salvo da terceira conta para as duas janelas e reúne os históricos existentes no registro compartilhado, preservando enviados e pendentes. Uma janela fica na cazetv e outra na TNT. A Cabuloso mantém suas regras e velocidade, com alternância conjunta desktop/Android: ambas usam sempre a mesma interface. O modo inicial segue `config.json`. Ctrl+C encerra as duas.

Com a terceira conta configurada, `npm run watch:2:accounts` mantém as mesmas duas janelas e passa a alternar entre as três contas. `--start-secondary` começa na segunda e segue para a terceira; `--start-third` começa na terceira e segue para a primeira. Para começar pela cabuloso:

```powershell
npm run watch:2:accounts -- --start-third
```

A terceira conta tem pastas próprias (`browser-profile-account3-tntsportsbr-1` e `browser-profile-account3-cazetv-1`). O login da TNT é reaproveitado na cazetv durante a preparação. Todas as contas configuradas precisam ter login salvo. O histórico compartilhado e as exclusões de conversas valem para as três contas; o usuário da terceira conta é incluído automaticamente na exclusão.

## Duas janelas com troca conjunta de conta

### Somente Galo, alternando desktop, Android e iPhone após falha de leitura

`npm run watch:2:account2` abre a cazetv e a TNT somente com `IG_SECOND_USERNAME` (atualmente `golsdodia.galo`), sem alternar contas. As duas janelas começam na mesma interface, definida em `config.json` ou por `--browser-mode`. Se uma falhar ao carregar as respostas, ou os comentários continuarem indisponíveis após a recarga já prevista, o acompanhamento pausa e fecha as duas. Somente depois de ambas encerrarem, reabre o par inteiro na próxima interface: desktop → Android (Pixel 7) → iPhone 13 → desktop. Nenhuma janela muda sozinha. Os envios só são liberados quando ambas confirmam a mesma conta e o mesmo modo. O iPhone participa somente na Galo; a Cabuloso segue conjuntamente desktop → Android → desktop.

O login da conta selecionada é preparado para as duas janelas; não é necessário autenticar outras contas para esse modo fixo. O histórico compartilhado reúne os registros existentes, preservando enviados e pendentes durante as trocas. O post que originou a falha é retomado pela janela correspondente. Mensagens de processos antigos e falhas simultâneas não provocam trocas extras.

Para abrir somente o navegador da Galo em modo iPhone, sem iniciar envios, use `npm run browser:account2:iphone`. Para iniciar a Galo já em iPhone, use `npm run watch:2:account2 -- --browser-mode iphone`. Feche antes qualquer janela que use o mesmo perfil. Depois de uma falha de leitura no iPhone, a Galo retoma no desktop e segue a sequência.

`npm run watch:2:galo-first` inicia as duas páginas na Galo em desktop. Cada falha de leitura faz o par inteiro avançar nesta sequência: Galo desktop → gabrieldastip desktop → Galo iPhone → gabrieldastip iPhone → Galo Android → gabrieldastip Android → Galo desktop, repetindo o fluxo. As janelas fecham juntas e a próxima etapa aguarda a confirmação de ambas na conta e interface esperadas. A terceira conta não participa desse comando. A espera por falhas consecutivas é preservada mesmo ao trocar a conta; o post a retomar e o histórico compartilhado também são mantidos. Uma leitura bem-sucedida nas duas janelas zera a espera sem mudar a posição no fluxo. Conta ou interface inesperada e fechamento manual encerram o par. Use `-- --dry-run` para testar leitura e filtros sem publicar; `-- --check` valida a configuração sem abrir janelas. Android e iPhone são emulações no Chromium do PC. Para parar uma execução aberta pelo assistente, use `.\scripts\stop-service.ps1`; no terminal em que você iniciou, use Ctrl+C.

O pequeno atraso antes dos cliques é definido por `delays.beforeClickMs` em `config.json`, e a digitação por `delays.typingMsPerChar`. Esses ajustes continuam ativos mesmo com `--no-action-delays`, que zera a pausa entre posts e desativa as pausas genéricas antigas, preservando a pausa entre respostas. A espera antes de publicar ocorre antes das conferências finais da conversa.

A primeira troca após uma falha é imediata. Se as interfaces recusarem em sequência, as próximas trocas aguardam 30 segundos, 60 segundos, 120 segundos etc., até o máximo de 30 minutos, com as duas janelas fechadas durante a espera. Essa espera zera quando ambas conseguem concluir uma passagem de leitura sem erro na mesma interface. A mudança de interface não garante que o Instagram libere a leitura. Um 429 interno isolado, erro HTTP de navegação, captcha ou envio incerto não disparam essa troca. Fechar manualmente uma das janelas encerra as duas, sem reabrir nem trocar conta. Ctrl+C também cancela uma retomada já agendada. É necessário reiniciar o comando para carregar alterações do código.

Feche os navegadores do projeto e execute:

```powershell
npm run watch:2:accounts
```

Para iniciar ambas as janelas com a segunda conta (`IG_SECOND_USERNAME`, atualmente `golsdodia.galo`), mantendo a troca conjunta:

```powershell
npm run watch:2:accounts -- --start-secondary
```

O acompanhamento inicia uma janela na cazetv e outra na TNT, ambas com `IG_USERNAME`. As duas precisam confirmar a conta antes de iniciar os envios. Se uma janela/processo terminar, ou todos os posts encontrados de uma janela estiverem adiados por falhas de leitura/carregamento, a outra é encerrada e o par retoma com a próxima conta configurada: `IG_SECOND_USERNAME`, depois `IG_THIRD_USERNAME` se definida, voltando à primeira ao completar a lista. Ctrl+C encerra o acompanhamento sem reiniciar. O terminal precisa permanecer aberto.

Os logins são reaproveitados da pasta `browser-profile-cazetv-1` para a conta principal e `browser-profile-account2-tntsportsbr-1` para a segunda conta. Na preparação, somente os cookies do Instagram são copiados para a outra sessão de cada conta. Se faltar login, use `npm run browser:caze1` ou `npm run browser:account2`, entre na conta correspondente e feche a janela antes de executar o acompanhamento.

O par aguarda o encerramento dos processos anteriores antes de reabrir. A retomada começa com 3 segundos de espera; falhas repetidas logo após abrir aumentam essa espera até 60 segundos. O histórico `data/replied.json` é compartilhado entre as contas e recebe os registros antigos da segunda conta, mantendo enviados e pendentes sem repetir respostas. Um 429 isolado segue o tratamento existente dos posts; a troca ocorre quando uma instância encerra ou todos os seus posts encontrados ficam indisponíveis após erro.

Nos modos sem acompanhamento de troca conjunta, quando todos os posts encontrados estiverem adiados por falha, o próximo ciclo aguarda até 60 segundos para consultar posts novos, ou menos se algum adiamento vencer antes. No modo `watch:2:accounts`, esse estado solicita a troca das duas janelas para a outra conta. O log mostra a causa e o horário real de nova tentativa de cada endereço; consultar a fila não renova os 30 minutos. Um post novo continua elegível independentemente dos outros endereços em espera.

Use `npm run watch:2:accounts:split` para começar com `golsdodia.galo` na cazetv e `gabrieldastip` na TNT, ambas no desktop. Após três recusas genéricas de envio, somente a janela afetada fecha e assume a conta ativa da outra página, no mesmo dispositivo; a outra janela continua trabalhando. A sessão é transferida pelo IPC local em memória e o login é confirmado antes da retomada. O post é retomado sem repetir os comentários já enviados ou pendentes no histórico compartilhado. As duas páginas podem passar a usar a mesma conta; quando não existe outra conta ativa diferente e disponível para assumir, somente a página recusada aguarda uma nova tentativa, com espera crescente de 30 segundos até 30 minutos. Recusas simultâneas não provocam troca de contas em loop.

Se o acompanhamento inteiro encerrar, um processo externo aguarda 15 minutos e tenta novamente do início, com as contas originais e desktop. Os encerramentos seguintes aguardam 30 minutos, 1 hora e 2 horas, repetindo 2 horas nas demais tentativas. A contagem continua durante a mesma execução, mesmo que uma tentativa consiga trabalhar por algum tempo. O histórico de enviados e pendentes é preservado. Ctrl+C ou `scripts/stop-service.ps1` cancela também a espera automática. O computador precisa estar ligado para executar; uma suspensão pode atrasar o horário da retomada. As trocas normais de conta/dispositivo que mantêm o acompanhamento ativo continuam com suas regras atuais.

Para usar somente `correa.tipss` nas duas páginas, configure `IG_FOURTH_USERNAME=correa.tipss` no `.env`, faça login com `npm run login:correa` e execute `npm run watch:2:correa`. Essa conta utiliza as pastas `browser-profile-account4-*`, preservando os logins anteriores. As duas janelas começam no desktop, alternam juntas desktop → Android → iPhone e mantêm o histórico compartilhado e as retomadas de 15/30/60/120 minutos. A nova conta também entra na exclusão de conversas já respondidas pelas nossas contas.

Para começar na conta principal e usar Correa após falhas nos três dispositivos, execute `npm run watch:2:gabriel-correa`. A sequência é gabrieldastip desktop → Android → iPhone, depois correa.tipss desktop → Android → iPhone, sempre com as duas páginas na mesma conta e dispositivo. Leitura concluída e envios bem-sucedidos mantêm o estado atual; as falhas seguem as esperas progressivas existentes. Se uma conta perder a sessão, exigir verificação, estiver suspensa ou um processo fechar, ambas fecham antes de tentar a outra conta no desktop. A conta indisponível é ignorada até o próximo reinício completo. Se ambas ficarem indisponíveis, o processo externo aplica as retomadas de 15/30/60/120 minutos começando novamente na conta principal em desktop. O histórico e a validação de conta permanecem obrigatórios antes de qualquer envio.

Falhas ao carregar comentários e respostas continuam alternando as duas janelas juntas desktop → Android → iPhone → desktop, mantendo as contas que estiverem ativas em cada página. Ambas fecham antes da troca e os envios só retomam após a confirmação das duas sessões e da interface. Encerrar o serviço cancela transferências e retomadas pendentes. Os delays de digitação e clique são definidos em `config.json` (atualmente zerados), e o comando desativa as pausas opcionais entre ações. Para validar o acompanhamento sem abrir navegadores, use `npm run test:pair`; para validar a espera dos posts indisponíveis, use `npm run test:retry`.

## Quando o Instagram mudar a interface

Os seletores usam textos e roles acessíveis, não classes CSS. Todos os textos ficam em `src/selectors.js`. Se algo parar de funcionar:

1. Rode `npm run dry` com o navegador visível e veja o log e os screenshots.
2. Ajuste o texto ou regex correspondente em `src/selectors.js`. Por exemplo, se o botão mudou de "Responder" para outro nome.
3. A identificação dos comentários depende dos links de data, que apontam para `/p/CODIGO/c/ID/`. Ela está em `extractComments` (`src/instagram/comments.js`).

Limitações conhecidas:

- O Instagram web ordena os comentários por relevância. O script carrega mais comentários até `maxLoadMore` vezes, mas em posts com muitos comentários alguns podem não aparecer.
- Uma resposta que você escreveu por outro dispositivo e que está escondida em "Ver respostas" é detectada, porque o script expande todas as respostas antes de decidir.
