# Modo agente

O agente usa como projeto uma pasta que escolher e executa nela o Claude Code ou o Codex deste PC. A IA lê sozinha o material da pasta, cria ficheiros novos, usa habilidades e scripts, e edita os documentos abertos no GenOffice. Use-o para trabalhos que se apoiam em muito material.

## Antes de começar

- O programa Claude Code ou Codex conectado em **Configurações ▸ IA** (com sessão iniciada com uma assinatura do Claude ou um plano do ChatGPT). O ChatGPT conectado diretamente no aplicativo não é usado pelo agente. O tópico «Conexão por assinatura» explica como.
- Uma pasta com o seu material. Não é possível escolher uma unidade inteira, toda a sua pasta pessoal nem pastas com dados de início de sessão ou de aplicações.

## Iniciar uma sessão

1. Na barra lateral esquerda do ecrã Início, clique em **Agente**. A janela do agente abre-se à parte.
2. Clique em **Escolher uma pasta…** para selecionar a pasta do projeto. As pastas usadas recentemente aparecem em **Pastas recentes**.
3. Em **Programa**, escolha o Claude Code ou o Codex. Um programa que não esteja conectado não pode ser escolhido.
4. Em **Quando perguntar a você**, escolha como o agente pede permissão (tabela abaixo).
5. Na primeira vez, leia **Antes de começar** e clique em **Entendi**.
6. Clique em **Iniciar**, escreva o que quer que seja feito e clique em **Enviar**.

Uma janela é uma sessão. Fechar a janela ou clicar em **Parar** termina a sessão, e o programa que o GenOffice iniciou para ela também é encerrado. Uma sessão termina também após 30 minutos sem nada enviado.

## Como o agente pergunta

| Opção                                                | Faz sem perguntar                                                     | Pergunta primeiro                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Perguntar antes de cada comando** (predefinida)    | Ler e gravar ficheiros na pasta do projeto, editar documentos abertos | Executar um comando ou script, ler fora da pasta do projeto          |
| **Perguntar antes de gravar e de executar comandos** | Ler ficheiros na pasta do projeto, editar documentos abertos          | Gravar um ficheiro, executar um comando ou script, ler fora da pasta |
| **Confiar neste projeto**                            | Quase tudo                                                            | Ler fora da pasta do projeto                                         |

Quando o agente pergunta, a janela mostra o que ele quer fazer (o comando completo, o caminho do ficheiro). Clique em **Permitir** ou **Recusar**.

Seja qual for a opção, o agente nunca:

- Substitui o ficheiro de um documento aberto num separador do GenOffice. Os documentos abertos são editados através da aplicação, por isso a alteração aparece logo no editor e o desfazer do editor anula-a.
- Grava fora da pasta do projeto.
- Toca nos dados de início de sessão do Claude ou do Codex, nem na pasta de dados do GenOffice.

## Claude Code e Codex

- O **Codex** executa os comandos no seu próprio espaço isolado, incluindo os que permitir. Só pode gravar na pasta do projeto, a internet fica bloqueada a menos que a ative, e não consegue ler os seus ficheiros pessoais fora do projeto. Quando uma sessão começa, o GenOffice verifica primeiro se este isolamento funciona neste PC, e não inicia se não funcionar.
- O **Claude Code** não consegue isolar comandos no Windows. Um comando que permitir pode chegar a todo o PC e à internet. É por isso que, em **Confiar neste projeto**, é o próprio revisor do Claude Code que verifica cada ação no seu lugar.

Um documento que alguém lhe enviou pode trazer instruções escondidas que mandam a IA fazer outra coisa. Numa pasta com material que não conhece, use uma das opções que perguntam.

## Pesquisa na web e internet

- O **Claude Code** pode pesquisar na web e ler páginas web, mas pergunta antes. Pergunta na primeira vez que pesquisa e por cada site cujas páginas lê. Na pergunta, **Permitir pesquisas nesta sessão** ou **Permitir este site nesta sessão** faz com que deixe de perguntar durante o resto da sessão. Em **Confiar neste projeto**, quem decide é o próprio revisor do Claude Code.
- Quando escolhe o **Codex**, o ecrã de início mostra mais duas definições.

| Definição                          | Opções                                         | No início         |
| ---------------------------------- | ---------------------------------------------- | ----------------- |
| **Pesquisa na web**                | Resultados salvos / Em tempo real / Desativada | Resultados salvos |
| **Acesso à internet dos comandos** | Desativado / Ativado                           | Desativado        |

- Resultados salvos vêm de conteúdo web recolhido previamente; Em tempo real pesquisa a web tal como está agora.
- As duas definições são memorizadas para cada pasta de projeto. Uma pasta usada pela primeira vez começa com os valores acima.
- Com o acesso à internet dos comandos ativado, os comandos que o Codex executa podem chegar à internet. Em **Confiar neste projeto** chegam lá sem perguntar, e instruções escondidas num documento recebido podem levá-los a enviar os seus dados para fora. Este aviso aparece quando o ativa. Ative-o só quando precisar. A habilidade integrada «Encontrar habilidades» só funciona com esta definição ativada.

## Notas do projeto e habilidades

- Se a pasta tiver um `CLAUDE.md` ou um `AGENTS.md`, o conteúdo é entregue ao agente como instruções. Escreva lá o que deve valer sempre: o tom, os termos, o formato dos documentos a criar.
- A janela do agente usa as habilidades ativadas em **Configurações ▸ Habilidades**. O Claude Code e o Codex recebem a mesma lista. Há mais sobre habilidades em [Habilidades](help://skills).
- As habilidades em `.claude/skills` e `.agents/skills` da pasta do projeto são usadas nessa sessão sem precisarem de ser ativadas.
- Se escolher uma habilidade com `/` ou `$` na caixa de entrada, é colocada antes do seu pedido uma instrução para ler e seguir essa habilidade.
- A lista de habilidades fica fixa quando a sessão começa. Se ativar ou desativar habilidades durante uma sessão, aparece «As habilidades alteradas valem a partir da próxima sessão».
- Quando o agente cria uma habilidade, aparece um cartão de habilidade na janela; quando encontra uma habilidade que vale a pena instalar, aparece uma pré-visualização de instalação. Nada é guardado nem instalado até clicar em **Salvar** ou **Instalar**, e uma habilidade instalada fica disponível a partir da próxima sessão.
- Os programas que os scripts de uma habilidade usam (Python, etc.) têm de estar instalados neste PC.
- Se usou o agente numa versão anterior, na primeira vez que abrir a janela do agente aparece, uma única vez, este aviso: «As habilidades agora são ativadas e desativadas em Configurações → Habilidades. As habilidades das pastas de habilidades do Claude e do Codex começam desativadas.» **Abrir configurações** leva-o diretamente lá.

## Ficheiros novos e documentos abertos

- Os ficheiros novos que o agente cria são guardados na pasta do projeto. Clique em **Abrir** nessa linha do registo de progresso para abrir o ficheiro num separador do GenOffice.
- Para que um documento aberto seja editado, abra-o primeiro no GenOffice e indique o nome dele no seu pedido.
- Um documento que abrir durante uma sessão pode ser editado a partir da sua mensagem seguinte.

## Privacidade e utilização

- O que ocultou da IA só fica oculto quando a aplicação lê para o agente um documento aberto no GenOffice. Os ficheiros que o agente lê sozinho da pasta são enviados tal como estão.
- Os termos pesquisados na web e os endereços das páginas lidas vão para a empresa do programa e para esses sites. Com o acesso à internet dos comandos do Codex ativado, os dados podem ir para onde quer que um comando se ligue.
- O agente trabalha em muitos passos, por isso gasta mais do limite da sua assinatura do que o painel de IA. Quando o limite se esgota, o pedido falha; o agente nunca passa para outra IA nem para uma conexão paga.

## Se algo correr mal

| O que a janela diz                                     | O que fazer                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| **Não conectado**                                      | Inicie sessão nesse programa em **Configurações ▸ IA**.           |
| **Esta pasta não pode ser usada**                      | Escolha uma pasta que contenha apenas o seu material de trabalho. |
| **O Codex não consegue abrir neste PC a área isolada** | Atualize o Windows ou escolha o Claude Code.                      |
| **O limite da sua assinatura acabou**                  | Envie novamente depois de o limite ser reposto.                   |
| **O programa é antigo demais para o modo agente**      | Atualize esse programa e depois clique em **Nova sessão**.        |
