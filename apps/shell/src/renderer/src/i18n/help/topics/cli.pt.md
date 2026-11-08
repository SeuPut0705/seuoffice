# Linha de comandos e agentes

Todas as instalações incluem um comando `ieumoffice` que conduz os mesmos motores que a janela usa — os mesmos analisadores, o mesmo escritor, o mesmo renderizador. Um ficheiro que a aplicação guarda e um ficheiro que o comando escreve são o mesmo ficheiro, e uma verificação que o painel de IA da aplicação ultrapassa é uma verificação que o comando também ultrapassa.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` mostra a superfície completa num único ecrã: cada comando com uma linha a dizer o que faz, depois as opções globais e os códigos de saída.

## Obter o comando

O comando vem dentro da aplicação. Para o chamar pelo nome, execute uma vez `ieumoffice install-cli`: no Windows, acrescenta ao seu `PATH` de utilizador a pasta onde está o comando, e os terminais que abrir a seguir encontram-no. **Configurações ▸ Integrações** mostra se o seu terminal já encontra o comando e, se não encontrar, a linha exata a executar.

Os agentes de programação não precisam desse passo. A aplicação regista em `~/.ieumoffice/launcher` onde está o comando, e eles encontram-no aí.

## Os comandos que vale a pena conhecer

| Comando           | O que faz                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Abre um documento na aplicação; arranca a aplicação se ela não estiver em execução.                                                                                                                                                                                                                   |
| `selection`       | O que o utilizador tem selecionado nesse ficheiro neste momento, enquanto a aplicação está em execução — o ponteiro para «este» / «aqui». Devolve um intervalo de blocos, um intervalo de células numa folha, elementos de um diapositivo ou uma página, conforme o editor em que o ficheiro estiver. |
| `convert`         | Converte entre formatos usando os motores da própria aplicação.                                                                                                                                                                                                                                       |
| `create`          | Cria um documento a partir de conteúdo estruturado.                                                                                                                                                                                                                                                   |
| `render`          | Um PNG por página, tal como o renderizador o dispõe.                                                                                                                                                                                                                                                  |
| `pdf`             | Lê a camada de texto de um PDF página a página, sem qualquer processo da aplicação.                                                                                                                                                                                                                   |
| `read-url`        | Lê o texto de uma página web a partir da linha de comandos — um artigo, um documento ou a ligação de uma competência; imprime o texto e continua com `--offset`.                                                                                                                                      |
| `info`            | Metadados e um resumo da estrutura de um documento.                                                                                                                                                                                                                                                   |
| `search`          | Pesquisa na web ou de imagens: a pesquisa gratuita por predefinição, ou o fornecedor de pesquisa cuja chave selecionou na aplicação.                                                                                                                                                                  |
| `image` / `media` | Gera uma imagem, ou descreve e faz perguntas sobre um ficheiro de imagem, vídeo ou áudio.                                                                                                                                                                                                             |
| `merge`           | Preenche os marcadores `{{key}}` num modelo `.docx`, `.pptx` ou `.xlsx`.                                                                                                                                                                                                                              |
| `capabilities`    | Indica que funcionalidades de IA (pesquisa, geração de imagens, análise de imagens e de vídeo) estão disponíveis nesta máquina, e por que via.                                                                                                                                                        |
| `guide`           | A referência de operações e os guias de design, gerados a partir das mesmas definições contra as quais o executor valida — por isso não pode divergir do que `apply` aceita. `--json` devolve-a com o esquema de cada operação.                                                                       |
| `install-cli`     | Coloca o `ieumoffice` no `PATH`.                                                                                                                                                                                                                                                                      |
| `skill`           | Lista os agentes de programação encontrados nesta máquina e instala ou atualiza neles a competência do GenOffice.                                                                                                                                                                                     |
| `mcp`             | Serve cada comando como uma ferramenta do Model Context Protocol. Consulte **Ligar um agente de programação**.                                                                                                                                                                                        |

## Edição: documentos, folhas, apresentações

`ieumoffice docs`, `ieumoffice sheet` e `ieumoffice slides` leem e editam pelo mesmo caminho de escrita que a aplicação usa, e partilham um vocabulário: uma **operação** (op) é uma única edição, e uma **especificação** (spec) é uma lista de operações aplicadas por ordem.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` relata o que um lote faria e não escreve nada, que é a forma barata de verificar uma especificação antes de a aplicar. O painel de IA da aplicação funciona exatamente com estas operações, por isso tudo o que lhe pedir também pode ser escrito em script.

## Os comandos de pesquisa, imagem e multimédia

`search`, `image` e `media` usam o que está configurado na aplicação em Configurações ▸ IA ▸ Avançado:

- `search` funciona sempre. Usa a pesquisa gratuita por predefinição, ou o fornecedor de pesquisa cuja chave selecionou.
- `image` precisa da chave de um fornecedor de imagens. Nesta versão, uma assinatura não gera imagens.
- `media` sobre uma imagem usa um fornecedor com chave quando há um configurado. Só usa a sua assinatura do Claude ou do Codex se o tiver autorizado, e isso vem **desligado por predefinição**; [Conectar um agente de programação](help://mcp) explica o interruptor e os seus limites.
- `media` sobre vídeo ou áudio precisa de um fornecedor com chave que suporte vídeo.

`ieumoffice capabilities --json` indica tudo isto sem chamar nenhuma IA. O seu `detail` contém:

| Campo                                                                            | O que indica                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Para cada funcionalidade: `available`; `via`, quem responde; `route`, um de `free`, `key` ou `subscription`; `metered: true` para um login de pagamento por consumo; e, quando a funcionalidade está indisponível, `message`, o texto com que o próprio comando responde. |
| `media_analysis`                                                                 | Mantido para scripts mais antigos: o mesmo que `image_analysis`, ou que `video_analysis` quando só o vídeo funciona.                                                                                                                                                      |
| `automatic_calls`                                                                | `subscription_enabled` e, enquanto estiver ligado, `used`, o número de pedidos automáticos tratados na última hora (apenas informativo); `limit` e `remaining` são sempre `null`.                                                                                         |
| `app`                                                                            | `available`: se a aplicação está instalada num sítio onde o comando a consegue iniciar.                                                                                                                                                                                   |
| `settings_path`                                                                  | O ficheiro de definições de onde estas respostas foram lidas.                                                                                                                                                                                                             |

Quando `image` ou `media` não pode ser executado, o comando termina com o código 4 e `error: "app_unavailable"`, e `detail.errorCode` diz porquê. `unavailable` significa que não há nada configurado para a funcionalidade, por isso tentar de novo não adianta. `rate-limit` vem com `detail.resetsAt`, a hora (em milissegundos) a que os pedidos voltam a ser possíveis.

## O que guarda neste PC

Os dois ficheiros estão na pasta `.ieumoffice`, dentro da sua pasta de utilizador:

- `~/.ieumoffice/launcher` regista onde está o comando da aplicação, para que um agente de programação o encontre mesmo quando não está no seu `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` recebe uma linha por cada comando executado — o comando, os argumentos e o resultado —, para poder ver depois o que um agente fez.

## Model Context Protocol

`ieumoffice mcp` serve cada comando como uma ferramenta MCP, e `ieumoffice mcp install <agent|all>` regista-a na configuração do próprio agente de programação. Consulte **Ligar um agente de programação** para esse lado.

## O que o comando não faz

Ele lê e escreve o ficheiro. Não é a aplicação: não há janela, e a janela de atualização da aplicação não se aplica. Tudo o que precisa da janela — o painel de IA, a verificação de qualidade de uma apresentação renderizada — tem de esperar que abra o ficheiro. `ieumoffice render` dá-lhe os píxeis sem ela, e `ieumoffice slides` audita a disposição de uma apresentação por si só.
