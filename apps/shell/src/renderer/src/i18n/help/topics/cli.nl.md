# Opdrachtregel en agents

Elke installatie bevat een `ieumoffice`-commando dat dezelfde engines aanstuurt als het venster — dezelfde parsers, dezelfde writer, dezelfde renderer. Een bestand dat de app opslaat en een bestand dat de opdracht schrijft zijn hetzelfde bestand, en een controle die het AI-paneel van de app doorstaat, doorstaat de opdracht ook.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` toont het hele oppervlak op één scherm: elke opdracht met een regel die zegt wat hij doet, en daarna de globale opties en de exitcodes.

## De opdracht bemachtigen

De opdracht wordt met de app meegeleverd. Om hem bij naam aan te roepen, voer je eenmaal `ieumoffice install-cli` uit: op Windows voegt dat de map met de opdracht toe aan je gebruikers-`PATH`, en terminals die je daarna opent, vinden hem. **Instellingen ▸ Integraties** laat zien of je terminal de opdracht al vindt en, zo niet, welke regel je precies moet uitvoeren.

Coding agents hebben die stap niet nodig. De app legt in `~/.ieumoffice/launcher` vast waar de opdracht staat, en daar vinden ze hem.

## De opdrachten die je moet kennen

| Opdracht          | Wat het doet                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Opent een document in de app; start de app als die niet draait.                                                                                                                                                                                                               |
| `selection`       | Wat de gebruiker in dat bestand op dit moment heeft geselecteerd, zolang de app draait — de aanwijzer voor "deze" / "hier". Geeft een blokbereik, een bereik in het werkblad, elementen op een slide of een pagina terug, afhankelijk van de editor waarin het bestand staat. |
| `convert`         | Converteert tussen formaten met de eigen engines van de app.                                                                                                                                                                                                                  |
| `create`          | Maakt een document van gestructureerde inhoud.                                                                                                                                                                                                                                |
| `render`          | Eén PNG per pagina, zoals de renderer het opmaakt.                                                                                                                                                                                                                            |
| `pdf`             | Leest de tekstlaag van een PDF pagina per pagina, zonder app-proces.                                                                                                                                                                                                          |
| `read-url`        | Leest de tekst van een webpagina vanaf de opdrachtregel — een artikel, een document of de link van een skill; print de tekst en gaat verder met `--offset`.                                                                                                                   |
| `info`            | Metadata en een structuuroverzicht van een document.                                                                                                                                                                                                                          |
| `search`          | Zoeken op het web of naar afbeeldingen: standaard de gratis zoekfunctie, of de zoekprovider waarvan je in de app de sleutel hebt geselecteerd.                                                                                                                                |
| `image` / `media` | Genereert een afbeelding, of beschrijft een afbeeldings-, video- of audiobestand en beantwoordt vragen erover.                                                                                                                                                                |
| `merge`           | Vult `{{key}}`-placeholders in een `.docx`-, `.pptx`- of `.xlsx`-sjabloon.                                                                                                                                                                                                    |
| `capabilities`    | Meldt welke AI-functies (zoeken, afbeeldingen genereren, afbeeldings- en video-analyse) op deze computer beschikbaar zijn, en via welke route.                                                                                                                                |
| `guide`           | De op-referentie en de ontwerphoogedelen, gegenereerd uit dezelfde definities waarop de executor valideert — dus kan niet afwijken van wat `apply` accepteert. `--json` geeft ze met het schema van elke op.                                                                  |
| `install-cli`     | Zet `ieumoffice` in de `PATH`.                                                                                                                                                                                                                                                |
| `skill`           | Toont de coding agents op deze computer en installeert of werkt de GenOffice-skill daarin bij.                                                                                                                                                                                |
| `mcp`             | Biedt elke opdracht aan als Model Context Protocol-tool. Zie **Verbinden met een coding agent**.                                                                                                                                                                              |

## Bewerken: docs, sheets, slides

`ieumoffice docs`, `ieumoffice sheet` en `ieumoffice slides` lezen en bewerken via hetzelfde schrijfpad als de app, en ze delen één woordenlijst: een **op** is één bewerking, en een **spec** is een lijst van ops die in volgorde worden toegepast.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` meldt wat een batch zou doen en schrijft niets, wat de goedkoopste manier is om een spec te controleren voordat die landt. Het AI-paneel in de app draait op precies deze ops, dus alles wat je het kunt vragen kun je ook scripten.

## De opdrachten voor zoeken, afbeeldingen en media

`search`, `image` en `media` gebruiken wat in de app is ingesteld onder Instellingen ▸ AI ▸ Geavanceerd:

- `search` werkt altijd. Het gebruikt standaard de gratis zoekfunctie, of de zoekprovider waarvan je de sleutel hebt geselecteerd.
- `image` heeft een sleutel van een afbeeldingsprovider nodig. In deze versie genereert een abonnement geen afbeeldingen.
- `media` op een afbeelding gebruikt een provider met een sleutel als die is ingesteld. Je Claude- of Codex-abonnement wordt alleen gebruikt als je dat hebt toegestaan, en dat staat **standaard uit**; [Verbinden met een coding agent](help://mcp) legt de schakelaar en de grenzen ervan uit.
- `media` op video of audio heeft een provider met een sleutel nodig die video ondersteunt.

`ieumoffice capabilities --json` meldt dit allemaal zonder een AI aan te roepen. In `detail` staat:

| Veld                                                                             | Wat het zegt                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Per functie: `available`; `via`, wie antwoordt; `route`, een van `free`, `key` of `subscription`; `metered: true` bij een aanmelding met betaling per verbruik; en, als de functie niet beschikbaar is, `message`, de tekst waarmee de opdracht zelf antwoordt. |
| `media_analysis`                                                                 | Behouden voor oudere scripts: hetzelfde als `image_analysis`, of als `video_analysis` wanneer alleen video werkt.                                                                                                                                               |
| `automatic_calls`                                                                | `subscription_enabled`, en zolang dat aan staat `used`, het aantal automatische verzoeken dat het afgelopen uur is afgehandeld (alleen ter informatie); `limit` en `remaining` zijn altijd `null`.                                                              |
| `app`                                                                            | `available`: of de app is geïnstalleerd op een plek waar de opdracht hem kan starten.                                                                                                                                                                           |
| `settings_path`                                                                  | Het instellingenbestand waaruit deze antwoorden zijn gelezen.                                                                                                                                                                                                   |

Kan `image` of `media` niet worden uitgevoerd, dan stopt de opdracht met code 4 en `error: "app_unavailable"`, en zegt `detail.errorCode` waarom. `unavailable` betekent dat er voor de functie niets is ingesteld, dus opnieuw proberen helpt niet. Bij `rate-limit` hoort `detail.resetsAt`, het tijdstip (in milliseconden) waarop verzoeken weer mogelijk zijn.

## Wat het op deze pc bewaart

Beide bestanden staan in de map `.ieumoffice` in je gebruikersmap:

- `~/.ieumoffice/launcher` legt vast waar de opdracht van de app staat, zodat een coding agent hem ook vindt als hij niet in je `PATH` staat.
- `~/.ieumoffice/cli-audit.jsonl` krijgt één regel voor elke opdracht die is uitgevoerd — de opdracht, de argumenten en het resultaat — zodat je achteraf kunt zien wat een agent heeft gedaan.

## Model Context Protocol

`ieumoffice mcp` biedt elke opdracht aan als MCP-tool, en `ieumoffice mcp install <agent|all>` registreert die in de eigen configuratie van een coding agent. Die kant staat in **Verbinden met een coding agent**.

## Wat de opdracht niet doet

Het leest en schrijft het bestand. Het is niet de app: er is geen venster, en het updatevenster in de app geldt hier niet. Alles wat het venster nodig heeft — het AI-paneel, de kwaliteitscontrole over een gerenderde slide — moet wachten tot je het bestand opent. `ieumoffice render` levert je de pixels zonder venster, en `ieumoffice slides` controleert de opmaak van een deck zelf.
