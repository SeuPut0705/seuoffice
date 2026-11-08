# Agentmodus

De agent neemt één map die je kiest als project en voert in die map Claude Code of Codex van deze pc uit. De AI leest zelf het materiaal in de map, maakt nieuwe bestanden, gebruikt vaardigheden en scripts en bewerkt de documenten die in GenOffice geopend zijn. Gebruik het voor werk waarvoor veel materiaal nodig is.

## Voordat je begint

- Het programma Claude Code of Codex, verbonden onder **Instellingen ▸ AI** (aangemeld met een Claude-abonnement of een ChatGPT-abonnement). Rechtstreeks in de app verbonden ChatGPT wordt niet door de agent gebruikt. Het onderwerp "Abonnementsverbinding" legt uit hoe.
- Een map met je materiaal erin. Een hele schijf, je hele gebruikersmap en mappen met aanmeld- of app-gegevens kun je niet kiezen.

## Een sessie starten

1. Klik in de linkerzijbalk van Start op **Agent**. Het agentvenster opent apart.
2. Klik op **Kies een map…** om de projectmap te kiezen. Mappen die je onlangs hebt gebruikt, staan onder **Recente mappen**.
3. Kies onder **Programma** Claude Code of Codex. Een programma dat niet verbonden is, kun je niet kiezen.
4. Kies onder **Wanneer je iets vragen** hoe de agent om toestemming vraagt (zie de tabel hieronder).
5. Lees de eerste keer **Voordat je begint** en klik op **Begrepen**.
6. Klik op **Starten**, schrijf wat er moet gebeuren en klik op **Versturen**.

Eén venster is één sessie. Als je het venster sluit of op **Stoppen** klikt, eindigt de sessie, en ook het programma dat GenOffice ervoor heeft gestart. Een sessie eindigt ook na 30 minuten waarin niets is verstuurd.

## Hoe de agent vraagt

| Keuze                                     | Doet meteen                                                             | Vraagt eerst                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Vragen voor elke opdracht** (standaard) | Bestanden in de projectmap lezen en schrijven, open documenten bewerken | Een opdracht of script uitvoeren, buiten de projectmap lezen                 |
| **Vragen voor schrijven en opdrachten**   | Bestanden in de projectmap lezen, open documenten bewerken              | Een bestand schrijven, een opdracht of script uitvoeren, buiten de map lezen |
| **Dit project vertrouwen**                | Bijna alles                                                             | Buiten de projectmap lezen                                                   |

Als de agent iets vraagt, toont het venster wat hij wil doen (de hele opdracht, het bestandspad). Klik op **Toestaan** of **Weigeren**.

Wat je ook kiest, de agent doet het volgende niet:

- Het bestand overschrijven van een document dat in een GenOffice-tabblad open staat. Open documenten worden via de app bewerkt, dus de wijziging is meteen in de editor te zien en met Ongedaan maken in de editor draai je haar terug.
- Buiten de projectmap schrijven.
- Aan de aanmeldgegevens van Claude of Codex komen, of aan de gegevensmap van GenOffice.

## Claude Code en Codex

- **Codex** voert opdrachten uit in zijn eigen afgeschermde ruimte, ook de opdrachten die je toestaat. Hij kan alleen in de projectmap schrijven, het internet is geblokkeerd tenzij je het aanzet, en je persoonlijke bestanden buiten het project kan hij niet lezen. Als een sessie start, controleert GenOffice eerst of die afscherming op deze pc werkt, en start niet als dat niet zo is.
- **Claude Code** kan op Windows opdrachten niet afschermen. Een opdracht die je toestaat, kan bij je hele pc en het internet. Daarom controleert bij **Dit project vertrouwen** de eigen controleur van Claude Code elke actie in jouw plaats.

Een document dat iemand je heeft gestuurd, kan verborgen instructies bevatten die de AI iets anders laten doen. Gebruik in een map met materiaal dat je niet kent een van de keuzes waarbij de agent vraagt.

## Zoeken op het web en internet

- **Claude Code** kan op het web zoeken en webpagina's lezen, maar vraagt dat eerst. Het vraagt de eerste keer dat het zoekt, en voor elke site waarvan het pagina's leest. In de vraag zorgt **Zoeken toestaan voor deze sessie** of **Deze site toestaan voor deze sessie** ervoor dat het de rest van de sessie niet meer vraagt. Bij **Dit project vertrouwen** beslist de eigen controleur van Claude Code.
- Kies je **Codex**, dan toont het startscherm nog twee instellingen.

| Instelling                          | Keuzes                             | In het begin          |
| ----------------------------------- | ---------------------------------- | --------------------- |
| **Zoeken op het web**               | Opgeslagen resultaten / Live / Uit | Opgeslagen resultaten |
| **Internettoegang voor opdrachten** | Uit / Aan                          | Uit                   |

- Opgeslagen resultaten komen uit webinhoud die vooraf is verzameld; Live zoekt op het web zoals het nu is.
- Beide instellingen worden per projectmap onthouden. Een map die je voor het eerst gebruikt, begint met de waarden hierboven.
- Staat internettoegang voor opdrachten aan, dan kunnen de opdrachten die Codex uitvoert het internet bereiken. Bij **Dit project vertrouwen** doen ze dat zonder te vragen, en verborgen instructies in een document dat je hebt ontvangen kunnen ze je gegevens naar buiten laten sturen. Deze waarschuwing verschijnt als je de instelling aanzet. Zet hem alleen aan als je hem nodig hebt. De ingebouwde vaardigheid "Vaardigheden zoeken" werkt alleen als deze instelling aanstaat.

## Projectnotities en vaardigheden

- Staat er in de map een `CLAUDE.md` of `AGENTS.md`, dan krijgt de agent de inhoud ervan als instructies. Schrijf daarin wat elke keer moet gelden: toon, termen, de vorm van de documenten die gemaakt moeten worden.
- Het agentvenster gebruikt de vaardigheden die aanstaan in **Instellingen ▸ Vaardigheden**. Claude Code en Codex krijgen dezelfde lijst. Meer over vaardigheden staat in [Vaardigheden](help://skills).
- Vaardigheden in `.claude/skills` en `.agents/skills` van de projectmap worden in die sessie gebruikt zonder dat je ze aanzet.
- Kies een vaardigheid met `/` of `$` in het invoervak, en vóór je verzoek komt de instructie om die vaardigheid te lezen en te volgen.
- De lijst met vaardigheden ligt vast zodra de sessie start. Zet je tijdens een sessie vaardigheden aan of uit, dan verschijnt "Gewijzigde vaardigheden gelden vanaf de volgende sessie".
- Maakt de agent een vaardigheid, dan verschijnt er een vaardigheidskaart in het venster; vindt hij een vaardigheid die het installeren waard is, dan verschijnt een installatievoorbeeld. Er wordt niets opgeslagen of geïnstalleerd tot je op **Opslaan** of **Installeren** klikt, en een geïnstalleerde vaardigheid is beschikbaar vanaf de volgende sessie.
- Programma's die de scripts van een vaardigheid gebruiken (Python en dergelijke) moeten op deze pc geïnstalleerd zijn.
- Heb je de agent in een eerdere versie gebruikt, dan zegt een eenmalige melding de eerste keer dat je het agentvenster opent: "Vaardigheden zet je nu aan en uit in Instellingen → Vaardigheden. Vaardigheden in de vaardighedenmappen van Claude en Codex staan eerst uit." **Instellingen openen** brengt je er meteen heen.

## Nieuwe bestanden en open documenten

- Nieuwe bestanden die de agent maakt, worden in de projectmap opgeslagen. Klik op **Openen** op die regel van het voortgangslogboek om het bestand in een GenOffice-tabblad te openen.
- Wil je een open document laten bewerken, open het dan eerst in GenOffice en noem het in je verzoek.
- Een document dat je tijdens een sessie opent, kan vanaf je volgende bericht worden bewerkt.

## Privacy en verbruik

- Wat je voor de AI hebt verborgen, blijft alleen verborgen als de app een document dat in GenOffice open staat voor de agent leest. Bestanden die de agent zelf uit de map leest, worden ongewijzigd verstuurd.
- Zoektermen op het web en de adressen van gelezen pagina's gaan naar het bedrijf achter het programma en naar die sites. Staat de internettoegang voor opdrachten van Codex aan, dan kunnen gegevens gaan naar elke plek waarmee een opdracht verbinding maakt.
- De agent werkt in veel stappen en gebruikt daardoor meer van de limiet van je abonnement dan het AI-paneel. Is de limiet op, dan mislukt het verzoek; de agent stapt nooit over op een andere AI of op een verbinding waarvoor je betaalt.

## Als er iets misgaat

| Wat het venster zegt                                                          | Wat je doet                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Niet verbonden**                                                            | Meld je bij dat programma aan onder **Instellingen ▸ AI**. |
| **Deze map kan niet worden gebruikt**                                         | Kies een map met alleen je eigen werkmateriaal.            |
| **Codex kan op deze pc de sandbox die zijn opdrachten afschermt niet openen** | Werk Windows bij of kies Claude Code.                      |
| **De limiet van je abonnement is op**                                         | Verstuur opnieuw zodra de limiet weer is aangevuld.        |
| **Het programma is te oud voor de agentmodus**                                | Werk dat programma bij en klik dan op **Nieuwe sessie**.   |
