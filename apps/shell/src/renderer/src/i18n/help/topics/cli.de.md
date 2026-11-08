# Kommandozeile und Agenten

Jede Installation bringt den Befehl `ieumoffice` mit, der dieselben Engines antreibt wie das Fenster: dieselben Parser, denselben Writer, denselben Renderer. Eine Datei, die die App speichert, und eine Datei, die der Befehl schreibt, sind dieselbe Datei, und eine Prüfung, die der KI-Bereich der App besteht, besteht auch der Befehl.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` zeigt die gesamte Oberfläche auf einem Bildschirm: jeder Befehl mit einer Zeile dazu, was er bewirkt, dann die globalen Optionen und die Exit-Codes.

## Den Befehl bereitstellen

Der Befehl wird mit der App geliefert. Um ihn beim Namen aufzurufen, einmal `ieumoffice install-cli` ausführen: Unter Windows wird der Ordner, in dem der Befehl liegt, in Ihren Benutzer-`PATH` aufgenommen, und danach geöffnete Terminals finden ihn. **Einstellungen ▸ Integrationen** zeigt, ob Ihr Terminal den Befehl bereits findet, und andernfalls die genaue Zeile, die Sie ausführen müssen.

Coding-Agenten brauchen diesen Schritt nicht. Die App hält in `~/.ieumoffice/launcher` fest, wo der Befehl liegt, und dort finden sie ihn.

## Die Befehle, die man kennen sollte

| Befehl            | Was er bewirkt                                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Ein Dokument in der App öffnen; startet die App, wenn sie nicht läuft.                                                                                                                                                                                                |
| `selection`       | Was der Benutzer in dieser Datei gerade ausgewählt hat, solange die App läuft — der Zeiger auf „dieser“ / „hier“. Gibt einen Blockbereich, einen Bereich im Tabellenblatt, Folienelemente oder eine Seite zurück, je nachdem, welchem Editor die Datei gerade gehört. |
| `convert`         | Zwischen Formaten mit den Engines der App konvertieren.                                                                                                                                                                                                               |
| `create`          | Ein Dokument aus strukturiertem Inhalt erstellen.                                                                                                                                                                                                                     |
| `render`          | Eine PNG-Datei pro Seite, so wie der Renderer sie setzt.                                                                                                                                                                                                              |
| `pdf`             | Die Textebene einer PDF-Datei Seite für Seite lesen, ohne einen App-Prozess zu starten.                                                                                                                                                                               |
| `read-url`        | Den Text einer Webseite über die Kommandozeile lesen — ein Artikel, ein Dokument oder der Link eines Skills; gibt den Text aus und fährt mit `--offset` fort.                                                                                                         |
| `info`            | Metadaten und eine Strukturübersicht eines Dokuments.                                                                                                                                                                                                                 |
| `search`          | Web- oder Bildsuche: standardmäßig die kostenlose Suche oder der Suchanbieter, dessen Schlüssel Sie in der App ausgewählt haben.                                                                                                                                      |
| `image` / `media` | Ein Bild erzeugen oder eine Bild-, Video- oder Audiodatei beschreiben und Fragen dazu stellen.                                                                                                                                                                        |
| `merge`           | Die Platzhalter `{{key}}` in einer Vorlage `.docx`, `.pptx` oder `.xlsx` füllen.                                                                                                                                                                                      |
| `capabilities`    | Melden, welche KI-Funktionen (Suche, Bildgenerierung, Bild- und Videoanalyse) auf diesem Rechner verfügbar sind und über welchen Weg.                                                                                                                                 |
| `guide`           | Die op-Referenz und die Design-Leitfäden, erzeugt aus genau den Definitionen, gegen die der Executor prüft — sie kann also nicht von dem abweichen, was `apply` akzeptiert. `--json` liefert sie mit dem Schema jedes ops.                                            |
| `install-cli`     | `ieumoffice` in den `PATH` legen.                                                                                                                                                                                                                                     |
| `skill`           | Die auf diesem Rechner gefundenen Coding-Agenten auflisten und den GenOffice-Skill dort installieren oder aktualisieren.                                                                                                                                              |
| `mcp`             | Jeden Befehl als Model-Context-Protocol-Werkzeug bereitstellen. Siehe **Einen Coding-Agenten anbinden**.                                                                                                                                                              |

## Bearbeiten: Dokumente, Tabellen, Folien

`ieumoffice docs`, `ieumoffice sheet` und `ieumoffice slides` lesen und schreiben über denselben Pfad wie die App und teilen ein Vokabular: ein **op** ist eine einzelne Änderung, und eine **spec** ist eine Liste von ops, die der Reihe nach angewendet werden.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` meldet, was ein Stapel tun würde, und schreibt nichts — so prüfen Sie eine spec günstig, bevor sie landet. Der KI-Bereich der App läuft auf genau diesen ops, Sie können also alles, was Sie ihm anvertrauen können, auch skripten.

## Die Befehle für Suche, Bilder und Medien

`search`, `image` und `media` verwenden, was in der App unter Einstellungen ▸ KI ▸ Erweitert eingerichtet ist:

- `search` funktioniert immer. Der Befehl nutzt standardmäßig die kostenlose Suche oder den Suchanbieter, dessen Schlüssel Sie ausgewählt haben.
- `image` braucht den Schlüssel eines Bildanbieters. In dieser Version erzeugt ein Abonnement keine Bilder.
- `media` nutzt für ein Bild einen Anbieter mit Schlüssel, wenn einer eingerichtet ist. Ihr Claude- oder Codex-Abonnement nutzt der Befehl nur, wenn Sie das erlaubt haben, und das ist **standardmäßig aus**; [Einen Coding-Agenten anbinden](help://mcp) erklärt den Schalter und seine Grenzen.
- `media` braucht für Video oder Audio einen Anbieter mit Schlüssel, der Video unterstützt.

`ieumoffice capabilities --json` meldet all das, ohne eine KI aufzurufen. Sein `detail` enthält:

| Feld                                                                             | Was es aussagt                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Für jede Funktion: `available`; `via`, wer antwortet; `route`, einer der Werte `free`, `key` oder `subscription`; `metered: true` bei einer Anmeldung mit Abrechnung nach Verbrauch; und, wenn die Funktion nicht verfügbar ist, `message`, der Text, mit dem der Befehl selbst antwortet. |
| `media_analysis`                                                                 | Für ältere Skripte beibehalten: dasselbe wie `image_analysis` oder wie `video_analysis`, wenn nur Video funktioniert.                                                                                                                                                                      |
| `automatic_calls`                                                                | `subscription_enabled` und, solange das eingeschaltet ist, `used`, die Zahl der in der letzten Stunde bearbeiteten automatischen Anfragen (nur zur Information); `limit` und `remaining` sind immer `null`.                                                                                |
| `app`                                                                            | `available`: ob die App dort installiert ist, wo der Befehl sie starten kann.                                                                                                                                                                                                              |
| `settings_path`                                                                  | Die Einstellungsdatei, aus der diese Angaben gelesen wurden.                                                                                                                                                                                                                               |

Wenn `image` oder `media` nicht laufen kann, endet der Befehl mit Code 4 und `error: "app_unavailable"`, und `detail.errorCode` nennt den Grund. `unavailable` bedeutet, dass für die Funktion nichts eingerichtet ist; ein erneuter Versuch hilft also nicht. `rate-limit` kommt mit `detail.resetsAt`, dem Zeitpunkt (in Millisekunden), ab dem Anfragen wieder möglich sind.

## Was der Befehl auf diesem PC ablegt

Beide Dateien liegen im Ordner `.ieumoffice` in Ihrem Benutzerordner:

- `~/.ieumoffice/launcher` hält fest, wo der Befehl der App liegt, damit ein Coding-Agent ihn auch dann findet, wenn er nicht in Ihrem `PATH` liegt.
- `~/.ieumoffice/cli-audit.jsonl` erhält für jeden ausgeführten Befehl eine Zeile — den Befehl, seine Argumente und das Ergebnis —, sodass Sie nachträglich sehen können, was ein Agent getan hat.

## Model Context Protocol

`ieumoffice mcp` stellt jeden Befehl als MCP-Werkzeug bereit, und `ieumoffice mcp install <agent|all>` registriert es in der Konfiguration eines Coding-Agenten. Diese Seite steht in **Einen Coding-Agenten anbinden**.

## Was der Befehl nicht tut

Er liest und schreibt die Datei. Er ist nicht die App: es gibt kein Fenster, und der Aktualisierungsdialog in der App gilt hierfür nicht. Alles, was das Fenster braucht — der KI-Bereich, die QC-Prüfung einer gerenderten Folie —, wartet darauf, dass Sie die Datei öffnen. `ieumoffice render` liefert Ihnen die Pixel auch ohne Fenster, und `ieumoffice slides` prüft das Layout eines Decks eigenständig.
