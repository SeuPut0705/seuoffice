# Tryb agenta

Agent traktuje jeden wybrany przez ciebie folder jako projekt i uruchamia w nim Claude Code lub Codex z tego komputera. AI samo czyta materiały w folderze, tworzy nowe pliki, korzysta z umiejętności i skryptów oraz edytuje dokumenty otwarte w GenOffice. Przydaje się do pracy, która wymaga sięgania do wielu materiałów.

## Zanim zaczniesz

- Program Claude Code lub Codex połączony w **Ustawienia ▸ AI** (zalogowany w ramach subskrypcji Claude lub planu ChatGPT). ChatGPT połączony bezpośrednio w aplikacji nie jest używany przez agenta. Jak to zrobić, wyjaśnia temat „Połączenie z subskrypcją”.
- Folder z twoimi materiałami. Nie można wybrać całego dysku, całego folderu domowego ani folderów z danymi logowania lub danymi aplikacji.

## Rozpoczynanie sesji

1. Na lewym pasku bocznym strony głównej kliknij **Agent**. Okno agenta otworzy się osobno.
2. Kliknij **Wybierz folder…**, aby wskazać folder projektu. Foldery używane ostatnio są wymienione w sekcji **Ostatnie foldery**.
3. W polu **Program** wybierz Claude Code lub Codex. Programu, który nie jest połączony, nie da się wybrać.
4. W polu **Kiedy pytać** wybierz, jak agent ma prosić o zgodę (tabela poniżej).
5. Za pierwszym razem przeczytaj sekcję **Zanim zaczniesz** i kliknij **Rozumiem**.
6. Kliknij **Rozpocznij**, napisz, co ma zostać zrobione, i kliknij **Wyślij**.

Jedno okno to jedna sesja. Zamknięcie okna lub kliknięcie **Zatrzymaj** kończy sesję, a razem z nią kończy się program, który GenOffice dla niej uruchomił. Sesja kończy się też po 30 minutach, w których nic nie zostało wysłane.

## Jak agent pyta

| Opcja                                         | Robi od razu                                                           | Najpierw pyta                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Pytaj przed każdym poleceniem** (domyślnie) | Odczyt i zapis plików w folderze projektu, edycja otwartych dokumentów | Uruchomienie polecenia lub skryptu, odczyt poza folderem projektu     |
| **Pytaj przed zapisem i poleceniami**         | Odczyt plików w folderze projektu, edycja otwartych dokumentów         | Zapis pliku, uruchomienie polecenia lub skryptu, odczyt poza folderem |
| **Ufaj temu projektowi**                      | Prawie wszystko                                                        | Odczyt poza folderem projektu                                         |

Gdy agent pyta, okno pokazuje, co chce zrobić (całe polecenie, ścieżkę pliku). Kliknij **Zezwól** lub **Odrzuć**.

Niezależnie od wybranej opcji agent nie będzie:

- Nadpisywać pliku dokumentu otwartego na karcie GenOffice. Otwarte dokumenty są edytowane przez aplikację, więc zmiana od razu pojawia się w edytorze, a cofanie w edytorze ją odwraca.
- Zapisywać niczego poza folderem projektu.
- Sięgać do danych logowania Claude ani Codex ani do folderu danych GenOffice.

## Claude Code i Codex

- **Codex** uruchamia polecenia we własnej izolowanej przestrzeni, także te, na które pozwolisz. Może zapisywać tylko w folderze projektu, internet jest zablokowany, chyba że go włączysz, a twoich prywatnych plików poza projektem nie może odczytać. Na początku sesji GenOffice najpierw sprawdza, czy ta izolacja działa na tym komputerze, i jeśli nie działa, sesja się nie rozpoczyna.
- **Claude Code** nie potrafi izolować poleceń w systemie Windows. Polecenie, na które pozwolisz, ma dostęp do całego komputera i internetu. Dlatego przy opcji **Ufaj temu projektowi** każdą czynność zamiast ciebie sprawdza własny weryfikator Claude Code.

Dokument, który ktoś ci przysłał, może zawierać ukryte instrukcje każące AI zrobić coś innego. W folderze z materiałami, których nie znasz, wybierz jedną z opcji, w których agent pyta.

## Wyszukiwanie w sieci i internet

- **Claude Code** może wyszukiwać w sieci i czytać strony internetowe, ale najpierw pyta. Pyta przy pierwszym wyszukiwaniu i przy każdej witrynie, której strony czyta. W pytaniu wybór **Zezwól na wyszukiwanie do końca sesji** lub **Zezwól na tę witrynę do końca sesji** sprawia, że do końca sesji już nie pyta. Przy opcji **Ufaj temu projektowi** decyduje własny weryfikator Claude Code.
- Gdy wybierzesz **Codex**, ekran startowy pokazuje jeszcze dwa ustawienia.

| Ustawienie                      | Opcje                                 | Na początku     |
| ------------------------------- | ------------------------------------- | --------------- |
| **Wyszukiwanie w sieci**        | Zapisane wyniki / Na żywo / Wyłączone | Zapisane wyniki |
| **Dostęp poleceń do internetu** | Wyłączony / Włączony                  | Wyłączony       |

- Zapisane wyniki pochodzą z treści internetowych zebranych wcześniej; Na żywo przeszukuje sieć w jej obecnym stanie.
- Oba ustawienia są zapamiętywane osobno dla każdego folderu projektu. Folder użyty po raz pierwszy zaczyna od powyższych wartości.
- Gdy dostęp poleceń do internetu jest włączony, polecenia uruchamiane przez Codex mogą łączyć się z internetem. Przy opcji **Ufaj temu projektowi** robią to bez pytania, a ukryte instrukcje w otrzymanym dokumencie mogą sprawić, że wyślą twoje dane na zewnątrz. To ostrzeżenie pojawia się przy włączaniu. Włączaj je tylko wtedy, gdy jest potrzebne. Wbudowana umiejętność „Znajdź umiejętności” działa tylko przy włączonym tym ustawieniu.

## Notatki projektu i umiejętności

- Jeśli w folderze jest `CLAUDE.md` lub `AGENTS.md`, jego treść trafia do agenta jako instrukcje. Zapisz w nim to, co ma obowiązywać za każdym razem: ton, terminologię, format dokumentów do przygotowania.
- Okno agenta korzysta z umiejętności włączonych w **Ustawienia ▸ Umiejętności**. Claude Code i Codex dostają tę samą listę. Więcej o umiejętnościach w temacie [Umiejętności](help://skills).
- Umiejętności z `.claude/skills` i `.agents/skills` w folderze projektu są używane w tej sesji bez włączania.
- Wybierz umiejętność przez `/` lub `$` w polu wpisywania, a przed twoją prośbą pojawi się polecenie, by przeczytać tę umiejętność i się do niej stosować.
- Lista umiejętności zostaje ustalona na początku sesji. Jeśli w trakcie sesji włączysz lub wyłączysz umiejętności, pojawi się „Zmienione umiejętności obowiązują od następnej sesji”.
- Gdy agent tworzy umiejętność, w oknie pojawia się karta umiejętności; gdy znajdzie umiejętność wartą zainstalowania, pojawia się podgląd instalacji. Nic nie zostanie zapisane ani zainstalowane, dopóki nie klikniesz **Zapisz** lub **Zainstaluj**, a zainstalowana umiejętność jest dostępna od następnej sesji.
- Programy, z których korzystają skrypty umiejętności (Python i inne), muszą być zainstalowane na tym komputerze.
- Jeśli korzystałeś z agenta we wcześniejszej wersji, przy pierwszym otwarciu okna agenta jednorazowy komunikat informuje: „Umiejętności włącza się i wyłącza teraz w Ustawienia → Umiejętności. Umiejętności z folderów umiejętności Claude i Codex są na początku wyłączone.” **Otwórz ustawienia** prowadzi prosto tam.

## Nowe pliki i otwarte dokumenty

- Nowe pliki utworzone przez agenta są zapisywane w folderze projektu. Kliknij **Otwórz** w odpowiednim wierszu dziennika postępu, aby otworzyć plik na karcie GenOffice.
- Aby agent edytował otwarty dokument, najpierw otwórz go w GenOffice i podaj jego nazwę w prośbie.
- Dokument otwarty w trakcie sesji można edytować od następnej wiadomości.

## Prywatność i zużycie

- To, co ukryjesz przed AI, pozostaje ukryte tylko wtedy, gdy aplikacja sama odczytuje dla agenta dokument otwarty w GenOffice. Pliki, które agent czyta z folderu samodzielnie, są wysyłane bez zmian.
- Wyszukiwane w sieci hasła i adresy czytanych stron trafiają do firmy, która udostępnia program, oraz do tych witryn. Gdy dostęp poleceń Codex do internetu jest włączony, dane mogą trafić wszędzie tam, z czym połączy się polecenie.
- Agent pracuje w wielu krokach, więc zużywa więcej limitu subskrypcji niż panel AI. Gdy limit się wyczerpie, prośba kończy się niepowodzeniem; agent nigdy nie przechodzi na inne AI ani na płatne połączenie.

## Gdy coś pójdzie nie tak

| Co pokazuje okno                                          | Co zrobić                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| **Brak połączenia**                                       | Zaloguj się do tego programu w **Ustawienia ▸ AI**.         |
| **Tego folderu nie można użyć**                           | Wybierz folder, w którym są tylko twoje materiały do pracy. |
| **Codex nie może otworzyć na tym komputerze piaskownicy** | Zaktualizuj system Windows albo wybierz Claude Code.        |
| **Limit subskrypcji został wyczerpany**                   | Wyślij ponownie po odnowieniu limitu.                       |
| **Program jest zbyt stary na tryb agenta**                | Zaktualizuj ten program, a potem kliknij **Nowa sesja**.    |
