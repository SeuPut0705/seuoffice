# Riga di comando e agenti

Ogni installazione include il comando `ieumoffice` che usa gli stessi motori della finestra — gli stessi parser, lo stesso writer, lo stesso renderer. Un file che l'app salva e un file che il comando scrive sono lo stesso file, e un controllo che il pannello IA dell'app supera è un controllo che il comando supera.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` mostra tutta la superficie in una sola schermata: ogni comando con una riga che dice cosa fa, poi le opzioni globali e i codici di uscita.

## Ottenere il comando

Il comando è incluso nell'app. Per richiamarlo per nome, esegui una volta `ieumoffice install-cli`: su Windows aggiunge al tuo `PATH` utente la cartella che contiene il comando, e i terminali che apri in seguito lo trovano. **Impostazioni ▸ Integrazioni** mostra se il tuo terminale trova già il comando e, in caso contrario, la riga esatta da eseguire.

Agli agenti di programmazione questo passaggio non serve. L'app annota in `~/.ieumoffice/launcher` dove si trova il comando, e loro lo trovano lì.

## I comandi da conoscere

| Comando           | Cosa fa                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Apre un documento nell'app; avvia l'app se non è in esecuzione.                                                                                                                                                                                                                                      |
| `selection`       | Che cosa l'utente ha selezionato in quel file in questo momento, mentre l'app è in esecuzione — il puntatore per «questo» / «qui». Restituisce un intervallo di blocchi, un intervallo di celle del foglio, elementi di una diapositiva o una pagina, a seconda dell'editor in cui si trova il file. |
| `convert`         | Converte tra formati usando i motori dell'app.                                                                                                                                                                                                                                                       |
| `create`          | Crea un documento da contenuto strutturato.                                                                                                                                                                                                                                                          |
| `render`          | Un PNG per pagina, così come il renderer impagina.                                                                                                                                                                                                                                                   |
| `pdf`             | Legge il livello di testo di un PDF pagina per pagina, senza processi dell'app.                                                                                                                                                                                                                      |
| `read-url`        | Legge il testo di una pagina web dalla riga di comando — un articolo, un documento o il link di una skill; stampa il testo e prosegue con `--offset`.                                                                                                                                                |
| `info`            | Metadati e un riepilogo della struttura di un documento.                                                                                                                                                                                                                                             |
| `search`          | Ricerca web o di immagini: la ricerca gratuita per impostazione predefinita, oppure il provider di ricerca di cui hai selezionato la chiave nell'app.                                                                                                                                                |
| `image` / `media` | Genera un'immagine, oppure descrivi e fai domande su un file immagine, video o audio.                                                                                                                                                                                                                |
| `merge`           | Compila i segnaposto `{{key}}` in un modello `.docx`, `.pptx` o `.xlsx`.                                                                                                                                                                                                                             |
| `capabilities`    | Riporta quali funzioni IA (ricerca, generazione di immagini, analisi di immagini e video) sono disponibili su questa macchina, e per quale via.                                                                                                                                                      |
| `guide`           | Il riferimento delle op e le guide di progettazione, generati dalle stesse definizioni contro cui l'executor valida — così non può divergere da ciò che `apply` accetta. `--json` lo restituisce con lo schema di ogni op.                                                                           |
| `install-cli`     | Mette `ieumoffice` sul `PATH`.                                                                                                                                                                                                                                                                       |
| `skill`           | Elenca gli agenti di programmazione trovati su questa macchina e installa o aggiorna in essi la skill GenOffice.                                                                                                                                                                                     |
| `mcp`             | Espone ogni comando come strumento Model Context Protocol. Vedi **Collegare un agente di programmazione**.                                                                                                                                                                                           |

## Modifica: Docs, Sheets, Slides

`ieumoffice docs`, `ieumoffice sheet` e `ieumoffice slides` leggono e modificano attraverso lo stesso percorso di scrittura che usa l'app, e condividono un vocabolario: un'**op** è una singola modifica e una **spec** è un elenco di op applicate in ordine.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` riporta cosa farebbe un batch e non scrive nulla, il modo più rapido per controllare una spec prima di applicarla. Il pannello IA dell'app funziona esattamente su queste op, quindi tutto ciò che puoi chiedergi puoi anche scriptarlo.

## I comandi di ricerca, immagini e media

`search`, `image` e `media` usano ciò che è configurato nell'app in Impostazioni ▸ IA ▸ Avanzate:

- `search` funziona sempre. Usa la ricerca gratuita per impostazione predefinita, oppure il provider di ricerca di cui hai selezionato la chiave.
- `image` richiede la chiave di un provider di immagini. In questa versione un abbonamento non genera immagini.
- `media` su un'immagine usa un provider con chiave quando ce n'è uno configurato. Usa il tuo abbonamento Claude o Codex solo se lo hai consentito, e questo è **disattivato per impostazione predefinita**; [Collegare un agente di programmazione](help://mcp) spiega l'interruttore e i suoi limiti.
- `media` su video o audio richiede un provider con chiave che supporta i video.

`ieumoffice capabilities --json` riporta tutto questo senza chiamare alcuna IA. Il suo `detail` contiene:

| Campo                                                                            | Che cosa indica                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Per ogni funzione: `available`; `via`, chi risponde; `route`, uno tra `free`, `key` e `subscription`; `metered: true` per un accesso a consumo; e, quando la funzione non è disponibile, `message`, il testo con cui risponde il comando stesso. |
| `media_analysis`                                                                 | Mantenuto per gli script più vecchi: uguale a `image_analysis`, oppure a `video_analysis` quando funziona solo il video.                                                                                                                         |
| `automatic_calls`                                                                | `subscription_enabled` e, finché è attivo, `used`, il numero di richieste automatiche gestite nell'ultima ora (solo a titolo informativo); `limit` e `remaining` sono sempre `null`.                                                             |
| `app`                                                                            | `available`: se l'app è installata in un punto da cui il comando può avviarla.                                                                                                                                                                   |
| `settings_path`                                                                  | Il file delle impostazioni da cui sono state lette queste risposte.                                                                                                                                                                              |

Quando `image` o `media` non possono essere eseguiti, il comando termina con il codice 4 e `error: "app_unavailable"`, e `detail.errorCode` dice perché. `unavailable` significa che per quella funzione non è configurato nulla, quindi riprovare non serve. `rate-limit` arriva con `detail.resetsAt`, l'orario (in millisecondi) in cui le richieste tornano possibili.

## Che cosa conserva su questo PC

Entrambi i file si trovano nella cartella `.ieumoffice` dentro la tua cartella utente:

- `~/.ieumoffice/launcher` annota dove si trova il comando dell'app, così un agente di programmazione lo trova anche quando non è nel tuo `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` riceve una riga per ogni comando eseguito — il comando, i suoi argomenti e il risultato — così puoi vedere in seguito che cosa ha fatto un agente.

## Model Context Protocol

`ieumoffice mcp` espone ogni comando come strumento MCP e `ieumoffice mcp install <agent|all>` lo registra nella configurazione di un agente di programmazione. Per quel lato, vedi **Collegare un agente di programmazione**.

## Che cosa non fa il comando

Legge e scrive il file. Non è l'app: non c'è finestra e la finestra di aggiornamento dell'app non si applica. Tutto ciò che richiede la finestra — il pannello IA, il controllo di qualità su una slide renderizzata — deve aspettare che tu apra il file. `ieumoffice render` ti dà i pixel senza di essa e `ieumoffice slides` verifica il layout di un deck da solo.
