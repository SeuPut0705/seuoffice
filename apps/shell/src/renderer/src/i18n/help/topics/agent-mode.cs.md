# Režim agenta

Agent vezme jednu složku, kterou zvolíte, jako projekt a spustí v ní Claude Code nebo Codex z tohoto počítače. AI samo čte podklady ve složce, vytváří nové soubory, používá dovednosti a skripty a upravuje dokumenty otevřené v GenOffice. Hodí se na práci, která čerpá z velkého množství podkladů.

## Než začnete

- Program Claude Code nebo Codex připojený v **Nastavení ▸ AI** (přihlášený předplatným Claude nebo tarifem ChatGPT). ChatGPT připojený přímo v aplikaci agent nepoužívá. Jak na to, vysvětluje téma „Připojení předplatného“.
- Složka s vašimi podklady. Nelze zvolit celý disk, celou domovskou složku ani složky s přihlašovacími nebo aplikačními daty.

## Zahájení relace

1. V levém panelu stránky Domů klikněte na **Agent**. Okno agenta se otevře samostatně.
2. Klikněte na **Vybrat složku…** a zvolte složku projektu. Nedávno použité složky najdete v seznamu **Nedávné složky**.
3. V poli **Program** zvolte Claude Code nebo Codex. Program, který není připojen, zvolit nelze.
4. V poli **Kdy se vás ptát** zvolte, jak bude agent žádat o svolení (viz tabulka níže).
5. Poprvé si přečtěte část **Než začnete** a klikněte na **Rozumím**.
6. Klikněte na **Spustit**, napište, co se má udělat, a klikněte na **Odeslat**.

Jedno okno je jedna relace. Zavřením okna nebo kliknutím na **Zastavit** relace skončí a s ní skončí i program, který pro ni GenOffice spustil. Relace skončí také po 30 minutách, během nichž nic neodešlete.

## Jak se agent ptá

| Volba                                      | Udělá rovnou                                                          | Nejdřív se zeptá                                                |
| ------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Ptát se před každým příkazem** (výchozí) | Čtení a zápis souborů ve složce projektu, úpravy otevřených dokumentů | Spuštění příkazu nebo skriptu, čtení mimo složku projektu       |
| **Ptát se před zápisem a příkazy**         | Čtení souborů ve složce projektu, úpravy otevřených dokumentů         | Zápis souboru, spuštění příkazu nebo skriptu, čtení mimo složku |
| **Důvěřovat tomuto projektu**              | Téměř všechno                                                         | Čtení mimo složku projektu                                      |

Když se agent ptá, okno ukáže, co chce udělat (celý příkaz, cestu k souboru). Klikněte na **Povolit** nebo **Odmítnout**.

Ať zvolíte cokoli, agent nikdy:

- Nepřepíše soubor dokumentu otevřeného na kartě GenOffice. Otevřené dokumenty se upravují přes aplikaci, takže se změna hned ukáže v editoru a vrátit ji jde běžným Zpět v editoru.
- Nezapisuje mimo složku projektu.
- Nesahá na přihlašovací údaje Claude ani Codex ani na datovou složku GenOffice.

## Claude Code a Codex

- **Codex** spouští příkazy ve vlastním izolovaném prostoru, včetně těch, které povolíte. Zapisovat může jen do složky projektu, internet má zablokovaný, pokud ho nezapnete, a vaše osobní soubory mimo projekt číst nemůže. Při zahájení relace GenOffice nejprve ověří, že tato izolace na tomto počítači funguje, a pokud ne, relaci nespustí.
- **Claude Code** ve Windows příkazy izolovat neumí. Příkaz, který povolíte, má přístup k celému počítači i k internetu. Proto u volby **Důvěřovat tomuto projektu** kontroluje každou akci místo vás vlastní kontrolor Claude Code.

Dokument, který vám někdo poslal, může obsahovat skryté pokyny, které AI navedou k něčemu jinému. Ve složce s podklady, které neznáte, používejte některou z voleb, u nichž se agent ptá.

## Vyhledávání na webu a internet

- **Claude Code** umí vyhledávat na webu a číst webové stránky, ale nejdřív se zeptá. Zeptá se při prvním vyhledávání a u každého webu, jehož stránky čte. Volba **Povolit vyhledávání po dobu této relace** nebo **Povolit tento web po dobu této relace** v dotazu zajistí, že se po zbytek relace už ptát nebude. U volby **Důvěřovat tomuto projektu** rozhoduje vlastní kontrolor Claude Code.
- Když zvolíte **Codex**, úvodní obrazovka ukáže ještě dvě nastavení.

| Nastavení                       | Volby                             | Na začátku       |
| ------------------------------- | --------------------------------- | ---------------- |
| **Vyhledávání na webu**         | Uložené výsledky / Živě / Vypnuto | Uložené výsledky |
| **Přístup příkazů k internetu** | Vypnuto / Zapnuto                 | Vypnuto          |

- Uložené výsledky pocházejí z webového obsahu shromážděného předem; Živě prohledává web v jeho současné podobě.
- Obě nastavení se pamatují pro každou složku projektu zvlášť. Složka použitá poprvé začíná s hodnotami uvedenými výše.
- Když je přístup příkazů k internetu zapnutý, příkazy, které Codex spouští, se mohou připojit k internetu. U volby **Důvěřovat tomuto projektu** to dělají bez ptaní a skryté pokyny v dokumentu, který jste dostali, je mohou přimět odeslat vaše data ven. Toto varování se zobrazí při zapnutí. Zapínejte ho jen tehdy, když ho potřebujete. Vestavěná dovednost „Najít dovednosti“ funguje jen se zapnutým tímto nastavením.

## Poznámky k projektu a dovednosti

- Pokud je ve složce `CLAUDE.md` nebo `AGENTS.md`, jeho obsah dostane agent jako pokyny. Zapište do něj, co má platit pokaždé: tón, termíny, formát dokumentů, které se mají vytvořit.
- Okno agenta používá dovednosti zapnuté v **Nastavení ▸ Dovednosti**. Claude Code i Codex dostanou stejný seznam. Více o dovednostech najdete v tématu [Dovednosti](help://skills).
- Dovednosti v `.claude/skills` a `.agents/skills` složky projektu se v dané relaci použijí, aniž by je bylo třeba zapnout.
- Vyberte dovednost pomocí `/` nebo `$` ve vstupním poli a před vaši žádost se vloží pokyn, aby si agent tuto dovednost přečetl a řídil se jí.
- Seznam dovedností se ustálí při zahájení relace. Pokud během relace dovednosti zapnete nebo vypnete, zobrazí se „Změněné dovednosti platí od další relace“.
- Když agent vytvoří dovednost, objeví se v okně karta dovednosti; když najde dovednost, kterou se vyplatí nainstalovat, objeví se náhled instalace. Dokud nekliknete na **Uložit** nebo **Nainstalovat**, nic se neuloží ani nenainstaluje, a nainstalovaná dovednost je k dispozici od další relace.
- Programy, které skripty dovedností používají (Python a další), musí být na tomto počítači nainstalované.
- Pokud jste agenta používali v dřívější verzi, při prvním otevření okna agenta se jednou zobrazí upozornění: „Dovednosti se nyní zapínají a vypínají v Nastavení → Dovednosti. Dovednosti ze složek dovedností Claude a Codex začínají vypnuté.“ **Otevřít nastavení** vás tam rovnou přenese.

## Nové soubory a otevřené dokumenty

- Nové soubory, které agent vytvoří, se ukládají do složky projektu. Kliknutím na **Otevřít** v příslušném řádku záznamu průběhu soubor otevřete na kartě GenOffice.
- Chcete-li, aby agent upravil otevřený dokument, nejprve ho otevřete v GenOffice a v požadavku ho uveďte jménem.
- Dokument, který otevřete během relace, lze upravovat od vaší další zprávy.

## Soukromí a spotřeba

- To, co jste před AI skryli, zůstane skryté jen tehdy, když aplikace agentovi sama čte dokument otevřený v GenOffice. Soubory, které agent čte ze složky sám, se odesílají tak, jak jsou.
- Hledané výrazy a adresy čtených stránek jdou ke společnosti, která program vydává, a na tyto weby. Když je u Codexu zapnutý přístup příkazů k internetu, data mohou jít kamkoli, kam se příkaz připojí.
- Agent pracuje v mnoha krocích, a proto spotřebuje víc z limitu předplatného než panel AI. Když se limit vyčerpá, požadavek selže; agent nikdy nepřejde na jinou AI ani na zpoplatněné připojení.

## Když se něco pokazí

| Co okno hlásí                                                  | Co udělat                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| **Nepřipojeno**                                                | Přihlaste se do daného programu v **Nastavení ▸ AI**.        |
| **Tuto složku nelze použít**                                   | Zvolte složku, ve které jsou jen vaše pracovní podklady.     |
| **Codex na tomto počítači nemůže otevřít izolované prostředí** | Aktualizujte Windows, nebo zvolte Claude Code.               |
| **Limit předplatného je vyčerpán**                             | Odešlete znovu, až se limit obnoví.                          |
| **Program je pro režim agenta příliš starý**                   | Aktualizujte daný program a pak klikněte na **Nová relace**. |
