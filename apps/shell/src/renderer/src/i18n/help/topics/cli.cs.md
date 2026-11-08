# Příkazová řádka a agenti

Každá instalace obsahuje příkaz `ieumoffice`, který používá stejné enginy jako okno — stejné parsery, stejný zapisovač, stejný vykreslovač. Soubor, který aplikace uloží, a soubor, který zapíše příkaz, je stejný soubor, a kontrola, kterou projde panel AI v aplikaci, projde i příkaz.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` ukáže celou plochu na jedné obrazovce: každý příkaz s řádkem, který říká, co dělá, a pak globální přepínače a návratové kódy.

## Získání příkazu

Příkaz se dodává uvnitř aplikace. Chcete-li ho volat jménem, spusťte jednou `ieumoffice install-cli`: ve Windows přidá složku s příkazem do vaší uživatelské `PATH` a terminály, které otevřete potom, ho už najdou. **Nastavení ▸ Integrace** ukazuje, zda váš terminál příkaz už najde, a pokud ne, přesný řádek, který máte spustit.

Programoví agenti tento krok nepotřebují. Aplikace zapisuje umístění příkazu do `~/.ieumoffice/launcher` a tam ho najdou.

## Příkazy, které stojí za to znát

| Příkaz            | Co dělá                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Otevře dokument v aplikaci; aplikaci spustí, pokud neběží.                                                                                                                                                    |
| `selection`       | Co uživatel právě vybral v tomto souboru, zatímco aplikace běží — ukazatel na „tady“ / „tenhle“. Vrací rozsah bloků, rozsah v listu, prvky snímku nebo stránku podle toho, v jakém editoru se soubor nachází. |
| `convert`         | Převádí mezi formáty pomocí vlastních enginů aplikace.                                                                                                                                                        |
| `create`          | Vytvoří dokument ze strukturovaného obsahu.                                                                                                                                                                   |
| `render`          | Jeden PNG na stránku, tak jak jej vykreslí vykreslovač.                                                                                                                                                       |
| `pdf`             | Čte textovou vrstvu PDF stránku po stránce, bez procesu aplikace.                                                                                                                                             |
| `read-url`        | Čte text webové stránky z příkazové řádky — článek, dokument nebo odkaz v dovednosti; vypíše text a pokračuje s `--offset`.                                                                                   |
| `info`            | Metadata a souhrn struktury dokumentu.                                                                                                                                                                        |
| `search`          | Vyhledávání na webu nebo vyhledávání obrázků: ve výchozím stavu bezplatné vyhledávání, nebo poskytovatel vyhledávání, jehož klíč jste v aplikaci vybrali.                                                     |
| `image` / `media` | Vygeneruje obrázek, nebo popíše soubor obrázku, videa či zvuku a umožní na něj dotazy.                                                                                                                        |
| `merge`           | Vyplní zástupné značky `{{key}}` v šabloně `.docx`, `.pptx` nebo `.xlsx`.                                                                                                                                     |
| `capabilities`    | Hlásí, které funkce AI (vyhledávání, generování obrázků, analýza obrázků a videí) jsou na tomto počítači dostupné a jakou cestou.                                                                             |
| `guide`           | Referenční příručka op a návrhové průvodce, vygenerované ze stejných definic, proti kterým executor validuje — takže se nemůže rozejít s tím, co přijímá `apply`. `--json` ji vrátí se schématem každé op.    |
| `install-cli`     | Umístí `ieumoffice` do `PATH`.                                                                                                                                                                                |
| `skill`           | Vypíše programové agenty nalezené na tomto počítači a nainstaluje do nich nebo v nich aktualizuje dovednost GenOffice.                                                                                        |
| `mcp`             | Vystaví každý příkaz jako nástroj Model Context Protocol. Viz **Připojení programového agenta**.                                                                                                              |

## Úpravy: Docs, Sheets, Slides

`ieumoffice docs`, `ieumoffice sheet` a `ieumoffice slides` čtou a upravují stejnou cestou zápisu, jakou používá aplikace, a sdílejí jednu slovní zásobu: **op** je jediná úprava a **spec** je seznam op aplikovaných v pořadí.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` hlásí, co by dávka udělala, a nic nezapíše — to je nejlevnější způsob, jak si spec před použitím ověřit. Panel AI v aplikaci běží přesně na těchto op, takže všechno, co mu můžete zadat, můžete i zapsat skriptem.

## Příkazy pro vyhledávání, obrázky a média

`search`, `image` a `media` používají to, co je nastaveno v aplikaci v Nastavení ▸ AI ▸ Pokročilé:

- `search` funguje vždy. Ve výchozím stavu používá bezplatné vyhledávání, nebo poskytovatele vyhledávání, jehož klíč jste vybrali.
- `image` potřebuje klíč poskytovatele obrázků. V této verzi předplatné obrázky negeneruje.
- `media` u obrázku používá poskytovatele s klíčem, pokud je nastaven. Vaše předplatné Claude nebo Codex použije jen tehdy, když jste to povolili, a to je ve výchozím stavu **vypnuté**; přepínač a jeho omezení popisuje [Připojení programového agenta](help://mcp).
- `media` u videa nebo zvuku potřebuje poskytovatele s klíčem, který podporuje video.

`ieumoffice capabilities --json` tohle všechno ohlásí, aniž by volal jakoukoli AI. Jeho `detail` obsahuje:

| Pole                                                                             | Co říká                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Pro každou funkci: `available`; `via`, kdo odpovídá; `route`, jedna z hodnot `free`, `key` nebo `subscription`; `metered: true` u přihlášení s platbou podle spotřeby; a když funkce není dostupná, `message`, text, kterým odpovídá sám příkaz. |
| `media_analysis`                                                                 | Zachováno pro starší skripty: totéž co `image_analysis`, nebo co `video_analysis`, pokud funguje jen video.                                                                                                                                      |
| `automatic_calls`                                                                | `subscription_enabled`, a dokud je zapnuto, také `used`, počet automatických požadavků vyřízených za poslední hodinu (jen pro informaci); `limit` a `remaining` jsou vždy `null`.                                                                |
| `app`                                                                            | `available`: zda je aplikace nainstalována tam, kde ji příkaz může spustit.                                                                                                                                                                      |
| `settings_path`                                                                  | Soubor nastavení, ze kterého byly tyto odpovědi načteny.                                                                                                                                                                                         |

Když `image` nebo `media` nelze spustit, příkaz skončí s kódem 4 a `error: "app_unavailable"` a `detail.errorCode` říká proč. `unavailable` znamená, že pro funkci není nic nastaveno, takže opakování nepomůže. K `rate-limit` patří `detail.resetsAt`, čas (v milisekundách), kdy budou požadavky znovu možné.

## Co uchovává v tomto počítači

Oba soubory jsou ve složce `.ieumoffice` ve vaší uživatelské složce:

- `~/.ieumoffice/launcher` zaznamenává, kde je příkaz aplikace, takže ho programový agent najde, i když není ve vaší `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` dostane jeden řádek za každý spuštěný příkaz — příkaz, jeho argumenty a výsledek — takže se později můžete podívat, co agent udělal.

## Model Context Protocol

`ieumoffice mcp` vystaví každý příkaz jako nástroj MCP a `ieumoffice mcp install <agent|all>` jej zaregistruje ve vlastní konfiguraci programového agenta. Této části se týká kapitola **Připojení programového agenta**.

## Co příkaz neumí

Čte a zapisuje soubor. Není to aplikace: není tu okno a dialog aktualizace v aplikaci zde neplatí. Všechno, co potřebuje okno — panel AI, kontrolu kvality vykreslené snímku — musí počkat, než soubor otevřete. `ieumoffice render` vám dá pixely bez něj a `ieumoffice slides` prověří rozvržení prezentace sám.
