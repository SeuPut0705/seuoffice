# Wiersz poleceń i agenci

Każda instalacja zawiera polecenie `ieumoffice`, które napędza te same silniki co okno — te same parsery, ten sam moduł zapisu, ten sam renderujący. Plik zapisany przez aplikację i plik zapisany przez polecenie to ten sam plik, a kontrola, którą przechodzi panel AI aplikacji, przechodzi też polecenie.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` pokazuje całą powierzchnię na jednym ekranie: każde polecenie z wierszem, który mówi, co robi, a potem opcje globalne i kody wyjścia.

## Zdobycie polecenia

Polecenie jest dostarczane razem z aplikacją. Aby wołać je po imieniu, uruchom raz `ieumoffice install-cli`: w systemie Windows dodaje to folder z poleceniem do twojej zmiennej `PATH` użytkownika, a terminale otwarte później już je znajdą. **Ustawienia ▸ Integracje** pokazuje, czy terminal już znajduje polecenie, a jeśli nie — dokładny wiersz, który trzeba uruchomić.

Agenci programistyczni nie potrzebują tego kroku. Aplikacja zapisuje położenie polecenia w `~/.ieumoffice/launcher` i tam je znajdują.

## Polecenia warte znajomości

| Polecenie         | Co robi                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Otwiera dokument w aplikacji; uruchamia aplikację, jeśli nie działa.                                                                                                                                                                     |
| `selection`       | To, co użytkownik właśnie zaznaczył w tym pliku, gdy aplikacja działa — wskaźnik „to” / „tutaj”. Zwraca zakres bloków, zakres komórek w arkuszu, elementy slajdu albo jedną stronę, w zależności od edytora, w którym znajduje się plik. |
| `convert`         | Konwertuje między formatami przy użyciu silników aplikacji.                                                                                                                                                                              |
| `create`          | Tworzy dokument z treści strukturalnej.                                                                                                                                                                                                  |
| `render`          | Jeden PNG na stronę, tak jak układa je renderujący.                                                                                                                                                                                      |
| `pdf`             | Odczytuje warstwę tekstową PDF-a strona po stronie, bez procesu aplikacji.                                                                                                                                                               |
| `read-url`        | Czyta tekst strony internetowej z wiersza poleceń — artykuł, dokument lub link ze skilla; wypisuje tekst i kontynuuje z `--offset`.                                                                                                      |
| `info`            | Metadane i podsumowanie struktury dokumentu.                                                                                                                                                                                             |
| `search`          | Wyszukiwanie w sieci lub wyszukiwanie obrazów: domyślnie bezpłatne wyszukiwanie albo dostawca wyszukiwania, którego klucz został wybrany w aplikacji.                                                                                    |
| `image` / `media` | Generuje obraz albo opisuje plik obrazu, wideo lub dźwięk i pozwala o niego pytać.                                                                                                                                                       |
| `merge`           | Wypełnia symbole zastępcze `{{key}}` w szablonie `.docx`, `.pptx` lub `.xlsx`.                                                                                                                                                           |
| `capabilities`    | Zgłasza, które funkcje AI (wyszukiwanie, generowanie obrazów, analiza obrazów i wideo) są dostępne na tym komputerze i jaką drogą.                                                                                                       |
| `guide`           | Referencja op i przewodniki projektowe, wygenerowane z tych samych definicji, względem których waliduje executor — więc nie może się rozjechać z tym, co przyjmuje `apply`. `--json` zwraca je ze schematem każdej op.                   |
| `install-cli`     | Umieszcza `ieumoffice` w `PATH`.                                                                                                                                                                                                         |
| `skill`           | Wypisuje agentów programistycznych znalezionych na tym komputerze i instaluje w nich lub aktualizuje skill GenOffice.                                                                                                                    |
| `mcp`             | Udostępnia każde polecenie jako narzędzie Model Context Protocol. Zobacz **Podłączenie z agentem programistycznym**.                                                                                                                     |

## Edycja: Docs, Sheets, Slides

`ieumoffice docs`, `ieumoffice sheet` i `ieumoffice slides` czytają i edytują przez tę samą ścieżkę zapisu co aplikacja i dzielą jedno słownictwo: **op** to pojedyncza zmiana, a **spec** to lista op zastosowanych po kolei.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` zgłasza, co zrobiłaby partia, i nic nie zapisuje — to najtańszy sposób na sprawdzenie spec przed zastosowaniem. Panel AI w aplikacji działa dokładnie na tych op, więc wszystko, o co możesz go zapytać, możesz też zapisać w skrypcie.

## Polecenia wyszukiwania, obrazów i mediów

`search`, `image` i `media` korzystają z tego, co skonfigurowano w aplikacji w Ustawienia ▸ AI ▸ Zaawansowane:

- `search` działa zawsze. Domyślnie korzysta z bezpłatnego wyszukiwania albo z dostawcy wyszukiwania, którego klucz został wybrany.
- `image` wymaga klucza dostawcy obrazów. W tej wersji subskrypcja nie generuje obrazów.
- `media` dla obrazu korzysta z dostawcy z kluczem, jeśli jest skonfigurowany. Z subskrypcji Claude lub Codex korzysta tylko wtedy, gdy na to pozwolisz, a jest to **domyślnie wyłączone**; przełącznik i jego ograniczenia opisuje [Podłączenie z agentem programistycznym](help://mcp).
- `media` dla wideo lub dźwięku wymaga dostawcy z kluczem obsługującego wideo.

`ieumoffice capabilities --json` zgłasza to wszystko bez wywoływania jakiegokolwiek AI. Jego `detail` zawiera:

| Pole                                                                             | Co mówi                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Dla każdej funkcji: `available`; `via` — kto odpowiada; `route` — jedno z `free`, `key` lub `subscription`; `metered: true` dla logowania rozliczanego za zużycie; a gdy funkcja jest niedostępna — `message`, czyli tekst, którym odpowiada samo polecenie. |
| `media_analysis`                                                                 | Zachowane dla starszych skryptów: to samo co `image_analysis`, albo co `video_analysis`, gdy działa tylko wideo.                                                                                                                                             |
| `automatic_calls`                                                                | `subscription_enabled`, a gdy jest włączone — `used`, liczba żądań automatycznych obsłużonych w ostatniej godzinie (tylko informacyjnie); `limit` i `remaining` są zawsze `null`.                                                                            |
| `app`                                                                            | `available`: czy aplikacja jest zainstalowana tam, gdzie polecenie może ją uruchomić.                                                                                                                                                                        |
| `settings_path`                                                                  | Plik ustawień, z którego odczytano te odpowiedzi.                                                                                                                                                                                                            |

Gdy `image` lub `media` nie może zadziałać, polecenie kończy się kodem 4 i `error: "app_unavailable"`, a `detail.errorCode` podaje przyczynę. `unavailable` oznacza, że dla tej funkcji nic nie jest skonfigurowane, więc ponowna próba nie pomoże. `rate-limit` ma przy sobie `detail.resetsAt`, czyli czas (w milisekundach), od którego żądania znów będą możliwe.

## Co polecenie przechowuje na tym komputerze

Oba pliki znajdują się w folderze `.ieumoffice` w twoim folderze użytkownika:

- `~/.ieumoffice/launcher` zapisuje położenie polecenia aplikacji, dzięki czemu agent programistyczny znajdzie je nawet wtedy, gdy nie ma go w twojej zmiennej `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` otrzymuje jeden wiersz dla każdego uruchomionego polecenia — polecenie, jego argumenty i wynik — więc później możesz sprawdzić, co zrobił agent.

## Model Context Protocol

`ieumoffice mcp` udostępnia każde polecenie jako narzędzie MCP, a `ieumoffice mcp install <agent|all>` rejestruje je we własnej konfiguracji agenta programistycznego. Tej strony dotyczy rozdział **Podłączenie z agentem programistycznym**.

## Czego polecenie nie robi

Czyta i zapisuje plik. To nie jest aplikacja: nie ma okna, a okno aktualizacji w aplikacji nie ma tu zastosowania. Wszystko, co wymaga okna — panel AI, kontrola jakości wyrenderowanej slajdy — musi poczekać, aż otworzysz plik. `ieumoffice render` daje ci piksele bez okna, a `ieumoffice slides` sam sprawdza układ prezentacji.
