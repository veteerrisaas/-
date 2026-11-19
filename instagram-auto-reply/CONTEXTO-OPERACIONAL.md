# Contexto operacional — Instagram Auto Reply

Atualizado em **19/11/2026**, após conferir o código e os JSONs do projeto.

Este documento permite retomar o projeto sem depender do histórico da conversa. Ele descreve a implementação e as preferências atuais; **não é uma autorização permanente para iniciar envios e não representa o estado dos processos em tempo real**. Pedidos posteriores do usuário prevalecem. Reconfira os arquivos quando houver divergência.

## 1. Resumo para uma sessão nova

- Conta remetente usada no fluxo atual: **@gbrdastip**, sem `s` no final.
- Quatro destinos, cada um em sua própria janela: **@tntsportsbr, @ge.globo, @espnbrasil e @sportv**.
- **@getv foi retirada** e permanece desativada em `profiles.json`. @cazetv também não é um destino ativo.
- Entrada principal: [src/start-gbrdastip.js](src/start-gbrdastip.js), com `--username gbrdastip --chrome-login` e um limite de execução explícito.
- Desktop inicialmente; troca sincronizada desktop → Android → iPhone → desktop nas falhas técnicas contempladas pelo código.
- As quatro sessões precisam confirmar o login antes de qualquer uma receber autorização para enviar.
- **Pausas de ação zeradas para @gbrdastip**, incluindo o intervalo compartilhado. Permanecem carregamentos, validações e esperas por erros/restrições.
- Banco SQLite compartilhado para não reutilizar textos; JSON compartilhado para não responder novamente ao mesmo ID de comentário.
- Filtros de luto, collab, contas excluídas, respostas anteriores, apenas emojis e intenção explícita de autoagressão permanecem ativos.
- Os limites já cadastrados para as três páginas novas **não foram removidos**: duas respostas por perfil/ciclo, conforme tabela abaixo.
- Quando o usuário pedir para parar ou ajustar sem reiniciar, encerrar também o serviço de retomada e conferir tarefas agendadas.
- Não presumir que o horário de ontem vale hoje. Usar data e fuso explícitos no limite autorizado para cada execução.

## 2. Ambiente e arquivos que determinam o comportamento

Projeto: `C:\Users\vitor.oliveira\Desktop\$\instagram-auto-reply`.

Node.js **24 ou superior**, módulos ES, Playwright com Chromium e SQLite nativo `node:sqlite`. O uso normal ocorre no Windows com navegador visível. A automação usa a interface web do Instagram; não é uma integração oficial com a API da Meta.

| Arquivo | Responsabilidade |
| --- | --- |
| [config.json](config.json) | Configuração geral, mapeamento de destinos e exceção de pausas zeradas por conta |
| [profiles.json](profiles.json) | Destinos habilitados, posts por perfil e limites por ciclo |
| [message-templates.json](message-templates.json) | Partes das mensagens curtas e regras de formato |
| [src/config.js](src/config.js) | Leitura, validação, variáveis de ambiente e configuração efetiva |
| [src/start-gbrdastip.js](src/start-gbrdastip.js) | Confere login, prepara sessões, inicia serviço e impõe horário final |
| [src/instance-layout.js](src/instance-layout.js) | Lista das quatro janelas atuais e lista legada de cinco |
| [src/service.js](src/service.js) / [src/service-restart.js](src/service-restart.js) | Serviço externo e esperas antes de reiniciar o acompanhamento |
| [src/watch-all.js](src/watch-all.js) / [src/pair-supervisor.js](src/pair-supervisor.js) | Distribuição dos destinos, confirmação das sessões, troca de modo e encerramento conjunto |
| [src/index.js](src/index.js) | Ciclos, seleção dos comentários, reservas, resultados e filtros |
| [src/browser.js](src/browser.js) / [src/human.js](src/human.js) | Navegadores, emulação, cliques, digitação e pausas |
| [src/instagram/reply.js](src/instagram/reply.js) | Conferências imediatamente antes do envio, vínculo com comentário pai e confirmação |
| [src/message-bank.js](src/message-bank.js) / [src/store.js](src/store.js) | Textos consumidos e histórico dos comentários, respectivamente |
| [src/instagram/post-safety.js](src/instagram/post-safety.js) | Bloqueio de posts de luto e avaliação da legenda |
| [src/instagram/collaboration.js](src/instagram/collaboration.js) | Identificação de collab no post exato |
| [src/instagram/comments.js](src/instagram/comments.js) / [src/message.js](src/message.js) | Leitura das conversas, contas excluídas e filtros de texto |
| [src/guard.js](src/guard.js) / [src/post-retry.js](src/post-retry.js) | Restrições, HTTP 429 e adiamento de posts indisponíveis |
| [src/logger.js](src/logger.js) / [src/report.js](src/report.js) | Logs, capturas e relatório CSV |
| [start-scheduled.ps1](start-scheduled.ps1) | Inicialização agendada única, com verificação de processos e recuperação de trava residual |

O `.env` e os diretórios de navegador contêm dados sensíveis. **Não copiar senhas, cookies ou tokens para este documento, logs de diagnóstico ou respostas.** O exemplo público é [.env.example](.env.example).

## 3. Destinos, janelas e limites atuais

| Destino | Identificador da janela | Posts recentes | Máximo por perfil/ciclo |
| --- | --- | --- | --- |
| @tntsportsbr | `tntsportsbr-1` | 3 | Sem limite configurado (`false`) |
| @ge.globo | `geglobo-1` | 3 | 2 |
| @espnbrasil | `espnbrasil-1` | 3 | 2 |
| @sportv | `sportv-1` | 3 | 2 |

`FOUR_PAGE_INSTANCES` e `--four` definem o fluxo atual. Os limites globais `limits.maxPerRun` e `limits.maxPerDay` estão como `false`, convertido em `Infinity`. Isso **não elimina** os limites de dois envios dos três perfis. Eles se renovam por ciclo, não por dia. Tentativas com resultado incerto também podem consumir quota.

`config.json` ainda aceita aliases legados. `instanceTargets.cazetv` aponta para `ge.globo`, mas a janela `cazetv-1` **não faz parte do layout atual**. `FIVE_PAGE_INSTANCES` e modos de duas/três janelas continuam no código por compatibilidade; não representam os destinos atualmente abertos pelo inicializador principal.

O padrão geral `postsToCheck: 5` é sobrescrito por `postsToCheck: 3` em cada perfil ativo. O fluxo usa `--single-worker` por destino; dividir um destino em dois workers pode repartir seus limites. Não confundir IDs internos das janelas com nomes das contas ou dos perfis visitados.

## 4. Contas e sessões de login

**@gbrdastip**, @gbrdastips, @gabrieldastip, @gabrieldastips e @gabdastips são nomes diferentes. Não trocar automaticamente uma conta por outra para fazer o login passar. A conta real deve ser confirmada no Instagram.

O inicializador principal define `IG_USERNAME` e `IG_PRIMARY_PROFILE_PREFIX` somente no seu processo e nos filhos. Não precisa sobrescrever o `.env` para selecionar @gbrdastip.

Fluxo atual com `--chrome-login`:

1. Usuário entra manualmente no Chrome instalado, usando o perfil `browser-profile-chrome-manual-gbrdastip`.
2. A janela manual é fechada antes de iniciar a automação, para liberar o diretório do perfil.
3. O inicializador abre esse perfil com o canal Chrome, confere cookie de sessão e a opção **Editar perfil** em `/gbrdastip/`.
4. Cookies do domínio Instagram são transferidos em memória para os quatro perfis de trabalho; valores não devem ser impressos.
5. O acompanhamento sincroniza as sessões dos destinos a partir da primeira janela do layout atual.
6. Cada worker verifica novamente conta e login. Somente após as quatro confirmações o acompanhamento envia `resume` para todos.

Perfis de trabalho da conta atual:

```text
browser-profile-gbrdastip-tntsportsbr-1
browser-profile-gbrdastip-geglobo-1
browser-profile-gbrdastip-espnbrasil-1
browser-profile-gbrdastip-sportv-1
```

Uma confirmação no perfil de origem **não garante** que as quatro sessões de trabalho continuem válidas. Já aconteceu de a origem passar e os workers pedirem login novamente.

Quando isso ocorrer, a preferência estabelecida é parar as retomadas e abrir o Chrome para o usuário reconectar. Depois que ele confirmar e fechar a janela, retomar com o horário final combinado.

[src/open-new-account.js](src/open-new-account.js) é outro fluxo: sem `--sequence`, abre iPhone; com `--sequence`, abre desktop → Android → iPhone ao fechar cada janela. Usa `browser-profile-manual-<usuario>`, **diferente** do perfil do Chrome acima. Não misturar as duas origens sem conferir `--chrome-login` e `--login-profile`.

## 5. Fluxo antes de responder

1. Buscar os posts recentes do perfil, evitando fixados quando `skipPinned: true`.
2. Abrir o post e conferir avisos de bloqueio/verificação.
3. Avaliar luto pela legenda e pelo texto acessível do post exato. Se reprovar ou não houver legenda legível, pular a publicação inteira.
4. Conferir colaboração: somente `status: solo` é liberado; collab ou autoria não confirmada são puladas.
5. Se configurado, conferir o mínimo de comentários. Hoje `minPostComments: 0`, portanto esse filtro está desativado.
6. Abrir comentários e tentar selecionar **Mais recentes**; ordenar os carregados por data quando necessário.
7. Com `loadAllComments: true`, carregar até três passagens sem IDs novos. Isso não garante que todos os comentários existentes foram entregues pelo Instagram. Nesse modo `maxLoadMore: 5` não é o limite efetivo.
8. Aplicar os filtros da conversa e do comentário.
9. Reservar um texto inédito no SQLite; preparar a resposta com `@autor`, pois `mentionUser: true`.
10. Antes de clicar, conferir novamente conversa, autor e estado de resposta; reservar o ID como `pending` no histórico.
11. Interceptar a requisição para conferir o vínculo com o comentário pai. Uma menção sozinha não autoriza a publicação.
12. Classificar o resultado e atualizar o histórico quando apropriado.

Filtros de comentário/conversa:

- Própria conta, contas configuradas no ambiente e contas excluídas fixas.
- Lista fixa atual: `gabrieltipss`, `gabrieldastip`, `golsdodia.colorado`, `golsdodia.colorado_`, `golsdodia.galo`; outras contas entram dinamicamente pelo ambiente.
- Autor com mais de um comentário principal entre os comentários únicos carregados do mesmo post.
- Conversa já contendo resposta de conta excluída, inclusive respostas conhecidas que saíram da tela.
- Respostas ainda fechadas ou incompletas que impeçam confirmar a segurança da conversa.
- ID já registrado como `pending` ou `sent`, ou resposta da própria conta já encontrada no comentário.
- Comentário composto apenas por emojis.
- Intenção explícita de autoagressão reconhecida pelas expressões de `src/message.js`, para não receber publicidade automática.
- Idade, quando ativada; atualmente `maxCommentAgeMin: 0`, sem filtro de idade.

Depois de um envio confirmado/provável, há sorteio de curtida com probabilidade **0,3**. A curtida depende da interface; falha ao curtir não autoriza repetir indiscriminadamente o clique.

## 6. Posts de luto

[src/instagram/post-safety.js](src/instagram/post-safety.js) avalia somente o post correspondente ao shortcode atual. Obtém legenda e texto acessível por dados React, JSON, cabeçalhos e metadados do próprio post.

Reconhece termos de falecimento, luto, condolências e homenagens póstumas em português e inglês. Expressões esportivas como **grupo da morte**, **morte súbita** e **morreu a jogada** são tratadas como metáforas quando não há outros sinais de morte real.

O shortcode **`DfibQK8jYr3`** está bloqueado explicitamente, mesmo que a legenda mude. Comentários de terceiros e metadados de outros posts não devem contaminar a classificação.

Sem legenda legível, o post é pulado. O filtro **não faz OCR nem classificação visual por IA**: pode não detectar uma homenagem escrita somente na imagem, uma expressão não prevista ou um contexto ambíguo. Não prometer cobertura perfeita.

## 7. Mensagens curtas e banco SQLite

- Mensagens com abertura de uma palavra em maiúsculas seguida de `!`, como **ATENÇÃO!**, **ALERTA!** e **DICA!**.
- Limite de **100 caracteres do texto**, incluindo emojis, antes da menção ao destinatário. O código usa o comprimento da string JavaScript.
- Objetivo atual: direcionar aos stories com variações de frases sobre “casa pra fazer a boa”.
- Estrutura atual: **20 aberturas × 50 perguntas × 50 chamadas = 50.000 combinações** em `message-templates.json`, com sufixo `😎✅`.
- Não há chamada a um modelo remoto para escrever cada mensagem. São combinações das listas locais, com ordem de procura aleatória.
- Conteúdos semanticamente semelhantes continuam possíveis. Unicidade de texto não significa assunto novo.

Banco: `data/messages.sqlite`, compartilhado entre contas e janelas. Tabelas principais:

| Tabela | Uso |
| --- | --- |
| `used_messages` | Texto, origem, momento de reserva e fingerprint único |
| `metadata` | Controle de importações de históricos |
| `send_pacing` | Próximo horário permitido quando existe intervalo configurado |

A normalização remove menção inicial, acentos, diferenças de caixa, pontuação e emojis; preserva letras/números normalizados e calcula SHA-256. Trocar só `@usuario`, emojis ou pontuação não torna o texto inédito.

O banco tenta primeiro os modelos originais de `profiles.json`/`config.json`, desde que atendam às regras e não tenham sido usados; depois tenta combinações. A reserva é atômica, com chave única. **Texto reservado não é liberado após falha anterior ou posterior ao clique**, para evitar reutilização de envio incerto.

Os arquivos `data/replied*.json` são importados por arquivo com marcador `history-v1:<nome>`, incluindo pendentes. Essa importação é feita uma vez por nome; não é uma sincronização contínua das alterações futuras feitas por versões antigas do sistema. Todas as novas execuções devem usar o banco.

Se os textos inéditos válidos acabarem, o sistema interrompe; não recicla textos nem acrescenta números aleatórios. O total disponível diminui com o uso. Não apagar o SQLite para “liberar” mensagens.

## 8. Histórico por comentário e relatório

[src/store.js](src/store.js) usa `data/replied.json` no fluxo com `--shared-history`.

- `pending`: reservado antes do clique; não é repetido automaticamente.
- `sent`: envio confirmado ou considerado provável; este último recebe `verified: false`.
- A chave é o ID do comentário, tratado como string para evitar arredondar números longos.
- O registro guarda perfil, post, URL do comentário, autor, conteúdo, texto respondido e datas.
- Pendentes contam no limite diário. Não há bloqueio global por pessoa em todos os posts: uma pessoa pode receber textos diferentes em comentários diferentes.
- Gravação passa por `replied.json.tmp` e renomeação, com até cinco tentativas de renomear.
- `replied.json.lock` impede gravações concorrentes; espera até cinco segundos e então informa **Registro ocupado**.
- Um JSON corrompido interrompe a execução para evitar perder a proteção contra duplicações.
- `relatorio-respostas.csv` é regenerado junto das gravações; falha no CSV gera aviso, não desfaz o JSON já salvo.

**Não confundir:** SQLite protege contra reutilizar textos; JSON protege contra responder novamente ao mesmo comentário. Os dois são necessários.

## 9. Resultados de envio

| Resultado | Tratamento atual |
| --- | --- |
| `confirmed` | Resposta encontrada no comentário pai esperado; marca `sent` |
| `probably` | Aceitação ou sinais de envio sem localização conclusiva; marca `sent`, `verified: false` |
| `unknown` / falha de rede | Mantém pendente, sem repetir o mesmo comentário |
| `skipped` | Cancela a tentativa por validação ou reserva; não significa envio |
| `wrong-target` | Requisição sem vínculo correto com o comentário pai; interrompe com reserva preservada |
| `rejected` genérico de interface | Conta recusas; três seguidas podem solicitar outra interface |
| `rate-limited` por HTTP 429 interno | Mantém a mensagem pendente, espera 60 segundos e abandona o post nessa passagem |
| Restrição explícita / CAPTCHA / verificação | `BlockedError`; interrompe worker e aciona encerramento do conjunto |

Oito envios consecutivos incertos interrompem a execução. Cinco ciclos consecutivos com erro também interrompem. HTTP **200 não prova sucesso**: o corpo pode informar `blocked` ou `rejected`.

## 10. Pausas zeradas: configuração efetiva

Em `config.json`, `zeroActionDelaysFor: ["gbrdastip"]` zera para essa conta:

- `betweenRepliesSec`, `betweenPostsSec`, `typingMsPerChar`, `beforeClickMs`;
- `watch.intervalMin`, isto é, a pausa configurada entre ciclos.

O inicializador detecta a exceção e transmite `IG_RUN_ZERO_DELAYS=true` aos filhos, além de `--no-action-delays` para as pausas genéricas. `claimSendSlot` retorna imediatamente para `[0, 0]`, inclusive se restar uma reserva anterior de intervalo positivo. Assim, as janelas não esperam uma vez no temporizador compartilhado.

Para outras contas, os valores atuais do JSON continuam: 15–20 s entre respostas, 3–5 s entre posts, 8–18 ms por caractere, 250–600 ms antes de cliques e 0,25–0,5 minuto entre ciclos.

Zerar pausas **não remove** rede, carregamento, timeouts, validações, consultas de conversa, trava de escrita nem pausas por falhas/restrições. Não garantir envio simultâneo ou tempo zero. A configuração atual também tem `quietHours: false`, `activeHours: [0, 24]`, sessões de trabalho periódicas desativadas e intervalo de descanso `[0, 0]`.

## 11. Modos, acompanhamento e retomadas

O Android é emulação de **Pixel 7** e o iPhone de **iPhone 13**, ambos no Chromium. Não são dispositivos físicos diferentes nem garantem desvinculação de contas.

Para @gbrdastip, falhas técnicas reconhecidas podem alternar desktop → Android → iPhone → desktop. No fluxo atual as janelas mudam juntas, após todas fecharem, e precisam confirmar novamente a conta. Não ocorre troca por um cronômetro fixo. Restrições explícitas, CAPTCHA e sessão ausente não são uma autorização para trocar de modo e continuar publicando.

Existem dois níveis de espera:

1. **Troca de interface:** primeira imediata; depois 30, 60, 120 segundos etc., limitada a 30 minutos. Leituras bem-sucedidas reiniciam esse contador.
2. **Reinício externo do acompanhamento:** 15, 30, 60 e 120 minutos; depois repete 120. Sempre começa com os argumentos originais, normalmente desktop. O contador não é reiniciado a cada comentário confirmado.

Um worker que encerra, perde sessão ou deixa de responder pode fechar todas as janelas. O acompanhamento verifica heartbeat; o padrão é 180 segundos. Mensagens de encerramento do acompanhamento com código `0` não provam que o trabalho concluiu sem erro: conferir as linhas anteriores e o `.err.log`.

Posts indisponíveis podem ser adiados por 30 minutos em memória, mantendo a busca de outros posts. Quando todos os encontrados estão adiados, há busca de novos endereços em até um minuto, ou antes se alguma espera vencer. Esse estado em memória não substitui o histórico persistente.

## 12. Horário final e tarefas agendadas

Horários combinados com o usuário usam **America/Sao_Paulo**. Exemplo de argumento: `--stop-at 2026-11-19T23:00:00-03:00`. Sempre substituir pela data/hora autorizada, não copiar datas vencidas.

- `--duration-minutes`: maior que zero e até 60; mede a partir do início do serviço após preparar o login.
- `--stop-at`: data/hora absoluta com fuso; precisa estar no futuro, nas próximas 24 horas.
- As duas opções são mutuamente exclusivas. Sem ambas, o inicializador não impõe horário final.
- O horário absoluto é reconferido após o login e não é empurrado por reinícios internos.
- No limite, a árvore do serviço é encerrada, incluindo browsers e retomadas internas.
- Parar o acompanhamento sem parar o inicializador/serviço externo pode deixar uma retomada pendente.

[start-scheduled.ps1](start-scheduled.ps1) não cria uma tarefa sozinho. Ele é executado pelo Agendador do Windows em tarefas únicas criadas conforme pedido do usuário. Confere horário, processos e trava residual, depois inicia o launcher com logs separados. O sucesso da tarefa do Windows não prova que o login passou, porque ela lança um processo em segundo plano.

As tarefas criadas nas sessões anteriores usam nomes `Instagram-gbrdastip-...`. Consultar estado, gatilho e próxima execução; não presumir tarefa recorrente. Com `LogonType: Interactive`, precisam de computador ligado, sem suspensão e usuário conectado. Desativar retomadas agendadas também quando o usuário mandar parar.

Os logs de `logger.js`, a data diária do histórico e `activeHours` usam o fuso local do sistema. `quietHours`, mensagens de retomada e os horários finais explicitam Brasília. Em outro servidor, configurar o fuso e conferir essa diferença.

## 13. Comandos de referência

Executar a partir da pasta do projeto. **Os comandos com envio real devem corresponder ao pedido atual do usuário.**

Validar configuração sem abrir browsers nem enviar:

```powershell
node src/start-gbrdastip.js --username gbrdastip --chrome-login --check
```

Executar um teste de cinco minutos:

```powershell
node src/start-gbrdastip.js --username gbrdastip --chrome-login --duration-minutes 5
```

Executar até um horário autorizado, com data explícita de exemplo:

```powershell
node src/start-gbrdastip.js --username gbrdastip --chrome-login --stop-at 2026-11-19T23:00:00-03:00
```

Verificação, importação de histórico e relatório sem iniciar comentários:

```powershell
npm test
npm run test:run-window
npm run messages:prepare
npm run report
```

`messages:prepare` cria/atualiza o SQLite e mostra exemplos, mas não reserva esses exemplos nem envia mensagens. `npm test` usa cenários locais; não publicar no Instagram para testar regras unitárias. O teste específico `test:run-window` é separado da suíte principal atual.

Para execução em segundo plano no Windows, usar `Start-Process` com `-WindowStyle Hidden`, diretório de trabalho correto e arquivos `.out.log`/`.err.log` próprios da execução. A janela manual de login deve ser visível. Registrar o PID raiz retornado e o caminho dos logs para as próximas verificações.

## 14. Antes de iniciar, retomar ou parar

1. Conferir data/hora atuais, conta exata, destinos e horário final solicitado.
2. Consultar processos Node e o comando do launcher; não iniciar duplicado.
3. Ler o log da execução mais recente, não apenas o log de ontem. Classificar a causa: horário final, erro técnico, restrição, autenticação ou trava.
4. Conferir tarefas agendadas que poderiam iniciar outra execução depois.
5. Se houver sessão expirada, abrir login manual e aguardar confirmação do usuário. Se houver pausa de segurança vigente, preservar sua finalidade e tratar qualquer antecipação com o contexto e as permissões do pedido atual.
6. Iniciar preservando o banco, os pendentes, os limites e os filtros.
7. Só informar **envios liberados** após constar a confirmação de todas as quatro sessões. Processos criados e origem autenticada, sozinhos, não bastam.
8. Ao parar, encerrar a árvore do launcher validado e conferir que os workers e as retomadas também terminaram.

Não usar `taskkill` contra todos os processos Node ou Chrome do computador. Conferir PID e linha de comando do projeto; há outros serviços Node no ambiente. Não tratar uma resposta simples como “fechou” como autorização automática para mudar conta ou apagar sessão.

## 15. Problemas conhecidos e diagnóstico

| Sintoma | O que verificar |
| --- | --- |
| `Registro ocupado: ...replied.json.lock` | Trava do JSON; não prova bloqueio do Instagram nem queda da internet |
| `EPERM ...replied.json.lock` | Acesso ao arquivo, contenção, antivírus e processos concorrentes |
| Origem autenticada, workers sem sessão | A cópia/validação das sessões pode não ter permanecido válida; reconectar manualmente |
| Muitas linhas de `pending` antes dos browsers | Cada worker imprime as pendências antigas; volume de logs pode atrasar muito a inicialização |
| `HTTP 200, blocked` | Restrição real informada no corpo; não interpretar apenas o código HTTP |
| Oito envios incertos | Conferência sem sucesso; preservar reservas, não reenviar automaticamente |
| Quatro janelas fecham juntas | Pode ser decisão do supervisor após falha de apenas uma |
| Tarefa Windows com resultado `0`, mas sem envios | Conferir os logs do processo Node iniciado pela tarefa |
| Página carrega, sem posts reconhecidos | Mudanças na interface, indisponibilidade do perfil, timeout ou falha de sessão |

**A trava recorrente do histórico ainda é um problema conhecido.** O sistema continua usando JSON, trava por arquivo e regeneração do CSV dentro da gravação. Não foi migrado integralmente para SQLite. A recuperação manual de um `.lock` residual não é correção definitiva de concorrência.

Antes de renomear uma trava residual: confirmar que não há launcher, serviço ou worker gravando; preservar JSON e eventuais temporários; conferir integridade do histórico. Preferir renomear para `.lock.stale-<data-hora>` a apagar. Nunca liberar uma trava de gravação viva apenas para acelerar envios. Um encerramento forçado pode deixar a trava para trás.

A exceção **Frame for this navigation request is not available** no monitor foi tratada em `src/guard.js`: ausência temporária de frame não derruba o processo e o monitor continua reconhecendo HTTP 429. Há teste específico em `test/guard-monitor.test.js`.

### Inconsistências legadas a conhecer

- Em `package.json`, **`watch:2:gbrdastips` aparece duas vezes**. O último valor aponta para `src/start-gbrdastips.js`, arquivo ausente na conferência desta documentação. O parser JSON usa o último valor. Não recomendar esse alias sem corrigir/verificar primeiro.
- `watch:2:gbrdastip` mantém nome legado, embora o launcher atual abra quatro janelas. Preferir o comando Node explícito para deixar conta, origem do login e horário final claros.
- Comentários e mensagens antigas podem mencionar duas/cinco janelas, @cazetv ou @getv; prevalecem `FOUR_PAGE_INSTANCES`, os perfis habilitados e os logs da execução atual.
- Não foi estabelecido nesta documentação que a execução está ativa ou parada; verificar processos e logs no momento do atendimento.

Essas inconsistências foram registradas, **não corrigidas**, durante a criação deste documento de apoio.

## 16. Preservação e manutenção deste contexto

Preservar `data/replied*.json`, `data/messages.sqlite` e os arquivos SQLite auxiliares quando presentes, relatórios e diretórios de sessão. Para copiar o banco com consistência, parar os processos e considerar os arquivos WAL/SHM; não copiar somente um banco em uso sem procedimento de backup adequado. Perfis de navegador são credenciais de sessão e exigem o mesmo cuidado do `.env`.

Não reiniciar banco/histórico para solucionar erros de rede. Não prometer que troca de navegador, modo ou VPS elimina associação entre contas ou restrições da plataforma.

Última validação de código registrada na conversa antes deste documento: **156 testes passaram**, incluindo pausas zeradas e monitor de navegação. Isso é um registro histórico, não uma execução de testes nesta atualização documental. Para mudanças futuras, executar os testes pertinentes e atualizar a contagem apenas com resultado real.

Ao mudar destinos, limites, conta, forma de login, delays, filtros, persistência ou comandos de operação, atualizar este arquivo. Manter o [README.md](README.md) consistente. Este documento não contém cookies, tokens ou senhas.
