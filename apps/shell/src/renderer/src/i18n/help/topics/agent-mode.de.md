# Agentenmodus

Der Agent nimmt einen Ordner Ihrer Wahl als Projekt und führt darin Claude Code oder Codex von diesem PC aus. Die KI liest die Unterlagen im Ordner selbst, erstellt neue Dateien, nutzt Skills und Skripte und bearbeitet die in GenOffice geöffneten Dokumente. Nutzen Sie ihn für Arbeiten, die auf viel Material zurückgreifen.

## Bevor Sie beginnen

- Das Programm Claude Code oder Codex, verbunden unter **Einstellungen ▸ KI** (angemeldet mit einem Claude-Abonnement oder einem ChatGPT-Tarif). Direkt in der App verbundenes ChatGPT wird vom Agenten nicht verwendet. Wie das geht, erklärt das Thema „Abonnement-Verbindung“.
- Ein Ordner mit Ihren Unterlagen. Ein ganzes Laufwerk, Ihr gesamter Benutzerordner und Ordner mit Anmelde- oder App-Daten lassen sich nicht wählen.

## Eine Sitzung starten

1. Klicken Sie in der linken Seitenleiste der Startseite auf **Agent**. Das Agentenfenster öffnet sich separat.
2. Wählen Sie über **Ordner wählen…** den Projektordner. Kürzlich verwendete Ordner stehen unter **Zuletzt verwendete Ordner**.
3. Wählen Sie unter **Programm** Claude Code oder Codex. Ein Programm, das nicht verbunden ist, lässt sich nicht wählen.
4. Legen Sie unter **Wann nachfragen** fest, wie der Agent um Erlaubnis fragt (Tabelle unten).
5. Lesen Sie beim ersten Mal **Bevor Sie beginnen** und klicken Sie auf **Verstanden**.
6. Klicken Sie auf **Starten**, schreiben Sie, was erledigt werden soll, und klicken Sie auf **Senden**.

Ein Fenster ist eine Sitzung. Wenn Sie das Fenster schließen oder auf **Stoppen** klicken, endet die Sitzung, und das Programm, das GenOffice dafür gestartet hat, wird ebenfalls beendet. Eine Sitzung endet außerdem, wenn 30 Minuten lang nichts gesendet wird.

## Wie der Agent nachfragt

| Auswahl                                | Läuft direkt                                                                 | Fragt zuerst                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Vor jedem Befehl fragen** (Standard) | Dateien im Projektordner lesen und schreiben, geöffnete Dokumente bearbeiten | Einen Befehl oder ein Skript ausführen, außerhalb des Projektordners lesen                |
| **Vor Schreiben und Befehlen fragen**  | Dateien im Projektordner lesen, geöffnete Dokumente bearbeiten               | Eine Datei schreiben, einen Befehl oder ein Skript ausführen, außerhalb des Ordners lesen |
| **Diesem Projekt vertrauen**           | Fast alles                                                                   | Außerhalb des Projektordners lesen                                                        |

Wenn der Agent fragt, zeigt das Fenster, was er tun will (den vollständigen Befehl, den Dateipfad). Klicken Sie auf **Erlauben** oder **Ablehnen**.

Unabhängig von Ihrer Auswahl tut der Agent Folgendes nie:

- Die Datei eines Dokuments überschreiben, das in einem GenOffice-Tab geöffnet ist. Geöffnete Dokumente werden über die App bearbeitet; die Änderung erscheint daher sofort im Editor, und das Rückgängigmachen im Editor nimmt sie zurück.
- Außerhalb des Projektordners schreiben.
- Die Anmeldedaten von Claude oder Codex oder den Datenordner von GenOffice anrühren.

## Claude Code und Codex

- **Codex** führt Befehle in seinem eigenen abgeschotteten Bereich aus, auch die, die Sie erlauben. Es kann nur in den Projektordner schreiben, das Internet ist gesperrt, solange Sie es nicht einschalten, und Ihre persönlichen Dateien außerhalb des Projekts kann es nicht lesen. Beim Start einer Sitzung prüft GenOffice zuerst, ob diese Abschottung auf diesem PC funktioniert, und startet nicht, wenn das nicht der Fall ist.
- **Claude Code** kann Befehle unter Windows nicht abschotten. Ein Befehl, den Sie erlauben, kann den ganzen PC und das Internet erreichen. Deshalb prüft bei **Diesem Projekt vertrauen** der eigene Prüfer von Claude Code jede Aktion an Ihrer Stelle.

Ein Dokument, das Ihnen jemand geschickt hat, kann versteckte Anweisungen enthalten, die die KI zu etwas anderem verleiten. Wählen Sie in einem Ordner mit Unterlagen, die Sie nicht kennen, eine der Optionen, die nachfragen.

## Websuche und Internet

- **Claude Code** kann im Web suchen und Webseiten lesen, fragt aber vorher. Es fragt beim ersten Suchen und bei jeder Website, deren Seiten es liest. In der Rückfrage sorgt **Suchen für diese Sitzung erlauben** oder **Diese Website für diese Sitzung erlauben** dafür, dass es für den Rest der Sitzung nicht mehr fragt. Bei **Diesem Projekt vertrauen** entscheidet der eigene Prüfer von Claude Code.
- Wenn Sie **Codex** wählen, zeigt der Startbildschirm zwei weitere Einstellungen.

| Einstellung                    | Auswahl                              | Anfangs                 |
| ------------------------------ | ------------------------------------ | ----------------------- |
| **Websuche**                   | Gespeicherte Ergebnisse / Live / Aus | Gespeicherte Ergebnisse |
| **Internetzugang für Befehle** | Aus / Ein                            | Aus                     |

- Gespeicherte Ergebnisse stammen aus vorab gesammelten Webinhalten; Live durchsucht das Web, wie es jetzt ist.
- Beide Einstellungen werden für jeden Projektordner gespeichert. Ein Ordner, der zum ersten Mal verwendet wird, beginnt mit den Werten oben.
- Ist der Internetzugang für Befehle eingeschaltet, können die Befehle, die Codex ausführt, das Internet erreichen. Bei **Diesem Projekt vertrauen** geschieht das ohne Rückfrage, und versteckte Anweisungen in einem erhaltenen Dokument könnten sie dazu bringen, Ihre Daten nach außen zu senden. Diese Warnung erscheint beim Einschalten. Schalten Sie den Zugang nur ein, wenn Sie ihn brauchen. Der integrierte Skill „Skills finden“ funktioniert nur, wenn diese Einstellung eingeschaltet ist.

## Projekthinweise und Skills

- Enthält der Ordner eine `CLAUDE.md` oder `AGENTS.md`, erhält der Agent deren Inhalt als Anweisung. Halten Sie dort fest, was jedes Mal gelten soll: Tonfall, Begriffe, das Format der zu erstellenden Dokumente.
- Das Agentenfenster verwendet die Skills, die unter **Einstellungen ▸ Skills** eingeschaltet sind. Claude Code und Codex erhalten dieselbe Liste. Mehr über Skills steht unter [Skills](help://skills).
- Skills in `.claude/skills` und `.agents/skills` des Projektordners werden in dieser Sitzung verwendet, ohne dass sie eingeschaltet sein müssen.
- Wählen Sie im Eingabefeld mit `/` oder `$` einen Skill, wird Ihrer Anfrage die Anweisung vorangestellt, diesen Skill zu lesen und zu befolgen.
- Die Skill-Liste wird beim Start der Sitzung festgelegt. Schalten Sie während einer Sitzung Skills ein oder aus, erscheint „Geänderte Skills gelten ab der nächsten Sitzung“.
- Erstellt der Agent einen Skill, erscheint eine Skill-Karte im Fenster; findet er einen Skill, der sich zu installieren lohnt, erscheint eine Installationsvorschau. Nichts wird gespeichert oder installiert, bevor Sie auf **Speichern** oder **Installieren** klicken, und ein installierter Skill ist ab der nächsten Sitzung verfügbar.
- Programme, die die Skripte eines Skills verwenden (Python usw.), müssen auf diesem PC installiert sein.
- Haben Sie den Agenten in einer früheren Version genutzt, erscheint beim ersten Öffnen des Agentenfensters einmalig der Hinweis: „Skills werden jetzt unter Einstellungen → Skills ein- und ausgeschaltet. Skills aus den Claude- und Codex-Skill-Ordnern sind anfangs ausgeschaltet.“ **Einstellungen öffnen** führt Sie direkt dorthin.

## Neue Dateien und geöffnete Dokumente

- Neue Dateien, die der Agent erstellt, werden im Projektordner gespeichert. Klicken Sie in der betreffenden Zeile des Verlaufsprotokolls auf **Öffnen**, um die Datei in einem GenOffice-Tab zu öffnen.
- Soll ein geöffnetes Dokument bearbeitet werden, öffnen Sie es zuerst in GenOffice und nennen Sie es in Ihrer Anfrage.
- Ein Dokument, das Sie während einer Sitzung öffnen, lässt sich ab Ihrer nächsten Nachricht bearbeiten.

## Datenschutz und Verbrauch

- Was Sie vor der KI verborgen haben, bleibt nur dann verborgen, wenn die App ein in GenOffice geöffnetes Dokument für den Agenten liest. Dateien, die der Agent selbst aus dem Ordner liest, werden unverändert gesendet.
- Suchbegriffe der Websuche und die Adressen gelesener Seiten gehen an das Unternehmen hinter dem Programm und an diese Websites. Ist bei Codex der Internetzugang für Befehle eingeschaltet, können Daten überallhin gelangen, wohin sich ein Befehl verbindet.
- Der Agent arbeitet in vielen Schritten und verbraucht daher mehr von Ihrem Abo-Limit als der KI-Bereich. Ist das Limit aufgebraucht, schlägt die Anfrage fehl; der Agent wechselt nie zu einer anderen KI oder zu einer kostenpflichtigen Verbindung.

## Wenn etwas schiefgeht

| Was im Fenster steht                                                                 | Was zu tun ist                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Nicht verbunden**                                                                  | Melden Sie sich unter **Einstellungen ▸ KI** bei diesem Programm an.      |
| **Dieser Ordner kann nicht verwendet werden**                                        | Wählen Sie einen Ordner, der nur Ihre Arbeitsunterlagen enthält.          |
| **Codex kann auf diesem PC die Sandbox, die seine Befehle abschottet, nicht öffnen** | Aktualisieren Sie Windows oder wählen Sie Claude Code.                    |
| **Das Limit Ihres Abos ist aufgebraucht**                                            | Senden Sie erneut, sobald das Limit zurückgesetzt ist.                    |
| **Das Programm ist zu alt für den Agentenmodus**                                     | Aktualisieren Sie das Programm und klicken Sie dann auf **Neue Sitzung**. |
