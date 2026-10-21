Exponential (repo i adres: `tracker`) to narzędzie zespołu do zgłoszeń, sprintów i spotkań, zbudowane na wzór Lineara (nazwa to mrugnięcie do niego: nie liniowo, a wykładniczo): gęste, ciemne, spokojne, z jednym kolorem marki i kolorami znaczeń, które mówią, co wymaga uwagi. Ten system jest **obowiązujący**: kod w `src/web` (repo `Wheatlay/tracker`) używa tylko tokenów i komponentów opisanych tutaj. Odstępstwo (nowy kolor, rozmiar, promień, wysokość kontrolki albo nowy wzór komponentu) wymaga zgody Krzysztofa przed scaleniem.

## Zasady dla agentów i ludzi

- Przed każdą zmianą UI przeczytaj ten README i kartę komponentu, który ruszasz.
- Kolor, rozmiar czcionki, promień i wysokość kontrolki bierz wyłącznie z tokenów (`var(--…)`). Literał (`#f2994a`, `13px`, `border-radius: 10px`) w `styles.css` albo w `style={{…}}` to błąd, chyba że jest na liście wyjątków niżej.
- Nie masz tokenu na to, czego potrzebujesz? Zatrzymaj się i zapytaj Krzysztofa. Nie dodawaj tokenu ani wartości sam.
- Źródłem wartości jest `src/web/styles.css` (bloki motywów i `:root` ze skalami); ten system jest jego odbiciem. Zmiana w jednym = zmiana w drugim w tym samym PR.

## Treść i ton

- Interfejs pisany jest po angielsku jako klucze, tłumaczony przez `t('…')` z `src/web/i18n.ts` na polski (`src/web/pl.ts`). Nowy tekst w UI = nowe hasło w `pl.ts`.
- Krótko, w trybie rozkazującym, nazwy rzeczy tak, jak ludzie je widzą: „Move to Done”, „Mark all as read”, „Join on Teams”. Bez wykrzykników, bez emoji.
- Wielka litera tylko na początku etykiety („Sprint review”, nie „Sprint Review”). Nazwy statusów zostają takie, jak je nazwał zespół.
- Komunikat o błędzie mówi, co się stało i co zrobić („Only project admins can set the default view”).
- Daty zawsze `dd.mm.rrrr`, godziny zawsze 24 h (`DateInput`, `TimeInput`), niezależnie od języka przeglądarki. Czas względny przez `timeAgo` („2 hours ago”).

## Kolor

- Trzy motywy: `dark` (domyślny), `light`, `oled`. Każdy komponent działa we wszystkich trzech; sprawdzaj co najmniej `dark` i `light`.
- Powierzchnie od najniższej: `bg-app` → `bg-primary` (panel) → `bg-secondary` (panele, komentarze) → `bg-card` (karty) → `bg-popover` (menu, okna). Najechanie `bg-hover`, wybrane `bg-active`.
- Tekst: `text-primary` treść, `text-secondary` etykiety, `text-tertiary` podpowiedzi i liczniki, `text-quaternary` tylko placeholdery i wyłączone.
- `accent` to jedyny kolor marki: przycisk główny, fokus, zaznaczenie, przełącznik, link. Napis w kolorze akcentu na tle: `accent-text`.
- Kolory znaczeń mają parę: wypełnienie (kropka, tło `color-mix(… 10–18%)`, ramka `color-mix(… 40–50%)`) i `-text` do napisów. Napis zawsze `-text`, nigdy samo wypełnienie:
  - `warning` — coś czeka na Ciebie: pytanie do mnie, brak notatek, Need Info, głosowanie.
  - `success` — zrobione, dobre: deploy udany, ktoś online, notatki HUMAN, odpowiedź.
  - `danger` — błąd, blokada, usuwanie.
  - `progress` — w toku: deploy trwa, ktoś był niedawno.
  - `ai` — wszystko, co robi Claude: analiza, przyciski AI, cudze przeciąganie.
  - `info` — nowe, nieprzeczytane.
  - `tech` — notatki techniczne, spotkania stałe i ankiety.
- Na pełnym wypełnieniu: `on-accent` (biały) na `accent`, `danger`, `ai`, `info`; `on-warning` (ciemny) na `warning`.
- Stan nigdy nie jest tylko kolorem: obok jest słowo, ikona albo podpowiedź (deploy ma `aria-label` i `title` ze słowem statusu).
- `avatar-1…8` i `project-1…7` to kolory tożsamości (awatary, kolory projektów). Nigdy nie oznaczają stanu.

## Typografia

- Jedna rodzina `sans` (Inter z Google Fonts, `cv11` + `ss01`), kod w `mono`.
- Skala: `text-xs` 11 · `text-sm` 12 · `text-md` 13 (domyślny) · `text-lg` 14 (czytanie: opis, komentarze) · `text-xl` 16 · `text-2xl` 20 · `text-3xl` 24 (tytuł zgłoszenia). Innych rozmiarów nie ma.
- Wagi: 400 tekst, 450 elementy menu i id, 500 etykiety i przyciski, 600 tytuły i odznaki, 700 tylko inicjały awatarów.
- Etykiety sekcji i odznaki: `text-xs`, wersaliki, `letter-spacing: 0.04em`.

## Wymiary

- Promienie: `radius-sm` 4 (odznaki, kbd, kod) · `radius-md` 6 (wiersze, przyciski, pola, ikony) · `radius-lg` 8 (karty, panele, popovery, kolumny) · `radius-xl` 12 (okna dialogowe, Display) · `radius-full` (pigułki, chipy, przełączniki). Kółka (awatary, kropki) `50%`.
- Kontrolki: `control-sm` 28 (chip, `.btn.sm`, przycisk-ikona, pozycja paska bocznego) · `control-md` 32 (przycisk, pole tekstowe, wyszukiwarka) · `control-lg` 36 (duże cele wyboru). Wiersze, które nie są kontrolkami (karta, wiersz menu 36, wiersz listy), mają własną wysokość.
- Odstępy układaj przez `gap` we flex/grid, w krokach 2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24.

## Zachowanie

- Niedostępna akcja jest wyszarzona z podpowiedzią podającą powód (`Tooltip` + `disabled`), nigdy ukryta; układ strony się nie zmienia.
- Najechanie nie przesuwa układu (np. „+” w komórce boardu zajmuje miejsce zawsze, tylko jest niewidoczny).
- Potwierdzenia przez `askConfirm` (okno aplikacji), nigdy systemowe `confirm()`/`alert()`.
- Filtry w kolumnach: lejek w nagłówku kolumny i popover.
- Animacje krótkie (80–200 ms), wyłączone przy `prefers-reduced-motion`.

## Wyjątki (dozwolone literały)

- `1px` promienie i grubości kresek dekoracyjnych.
- `#e4e4e7`, `rgb(0 0 0 / …)`, `rgb(255 255 255 / …)` na przyciskach nakładanych na obrazki i w podglądzie obrazu (zawsze na ciemnym tle).
- Cienie i przyciemnienia tła (`rgb(0 0 0 / x)`) w `shadow-*` i `.backdrop`.
- Szerokości układu (kolumny boardu 336/168, panel 300/320, okna 420/560/640/720).
- Kolory zapisywane w danych, nie w wyglądzie: domyślny kolor nowej etykiety i projektu (`#5e6ad2`), listy `AVATAR_COLORS` i `COLORS` (= `avatar-*`, `project-*`).

## Ikony

Własny zestaw w `src/web/icons.tsx` (`Icon.*`): obrysowe, 16×16, kreska 1.4, kolor z `currentColor`. Nowej ikony nie rysuj z pamięci innego zestawu; dodaj ją do `icons.tsx` w tym samym stylu. Znak marki (H1): sama sylwetka pola pod krzywą wykładniczą, bez kafla: płaski ogon z lewej, stromy klif z prawej; wypełnienie `accent`, krawędź krzywej `accent-hover` (`assets/Logos/exponential-mark.svg`, w kodzie `BrandMark` z `icons.tsx`, favicon w `index.html`). Nazwa pisana zawsze „Exponential”. W tytule karty przeglądarki: „<Projekt> · Exponential”, na stronie zgłoszenia „<ID> <tytuł> · <Projekt> · Exponential”. Nazwy techniczne (repo `tracker`, adres, serwer MCP `tracker`, protokół `tracker://`) zostają bez zmian.
