---
name: analyze-tracker-ticket
description: >
  Robi analizę AI problemu dla zgłoszeń w Trackerze, które ktoś oznaczył przyciskiem "Analyze"
  (flaga analysisRequested). Czyta zgłoszenie i kod repo, zapisuje analizę w sekcjach z decyzjami
  do kliknięcia. Użyj, gdy użytkownik mówi "zrób analizy", "przeanalizuj zgłoszenia",
  "co czeka na analizę", "przeanalizuj ACME-123", albo nazywa skill po imieniu.
---

# Analyze tracker ticket

Analizę czyta człowiek z zespołu (niekoniecznie programista), który decyduje, czy i jak brać
zadanie. Ma ją przeczytać w minutę i od razu kliknąć decyzje. Tracker pokazuje każdą sekcję
osobno, a decyzje jako opcje do wyboru. To nie jest raport z przeszukania kodu: co sprawdziłeś
i odrzuciłeś, zostaje u Ciebie.

## Krok 1: co czeka

- Podany numer (np. "ACME-123"): analizujesz tylko jego, nawet bez flagi.
- Bez numeru: `mcp__tracker__list_issues` z `analysisRequested: true`. Pusta lista = powiedz
  to w jednym zdaniu i skończ. Kilka zgłoszeń = po kolei, każde osobno.

## Krok 2: sprawdź w kodzie

1. `mcp__tracker__get_issue` i `mcp__tracker__list_comments`.
2. Ustal typ: `bug` (coś działa źle), `feature` (czegoś brakuje albo ma działać inaczej),
   `investigate` (pytanie "czemu", "sprawdzić", "ustalić").
3. Znajdź w kodzie miejsce, które o tym decyduje, i to, z czym się łączy (Grep/Read). Szukaj
   tyle, żeby wypełnić sekcje, nie więcej.
4. **Opis krótki, pusty albo niejasny:** przyjmij najbardziej prawdopodobne odczytanie, ale
   pierwszą decyzją zrób "O co chodzi w zgłoszeniu?". Wśród opcji daj też odczytanie odwrotne
   albo podważające założenie zgłoszenia (np. "szablon faktury musi być inny" → opcja "zrezygnować
   z osobnego szablonu faktury"). Zespół często wybiera właśnie to.

## Krok 3: zapisz

`mcp__tracker__set_analysis` z polami `id`, `type`, `sections`, `decisions`.

**Styl sekcji: zwarty.** Zwykły tekst w języku zgłoszenia (tym samym, w którym napisany jest opis; przy wątpliwości po angielsku), jedno, najwyżej dwa krótkie zdania na sekcję,
równoważniki tam, gdzie zdanie nic nie dodaje. Żadnych wstępów, powtórzeń między sekcjami,
"warto zauważyć", "należy". Wszystkie sekcje razem najwyżej ok. 180 słów. Pustą sekcję pomiń.

Sekcje zależne od typu:

| typ | sekcja | treść |
|---|---|---|
| bug | `verdict` | "Tak · przyczyna" / "Nie · dlaczego" / "Niepewne · co sprawdzić" |
| bug | `howToCheck` | kroki w aplikacji po strzałkach: "Kontrakty → Nowy → … → Zapisz" |
| feature | `current` | co już jest, czego brakuje |
| investigate | `answer` | co ustalono w kodzie (i czego nie dało się ustalić bez żywego testu) |

Analiza to punkt startowy: same fakty ustalone w kodzie, bez propozycji stanu docelowego (ten
ustala zespół w decyzjach). Nie pisz sekcji `todo` ani `after` (zostały w starych analizach).

Sekcje dla każdego typu:

- `system` („Co jeszcze to dotyka”): inne ekrany, procesy lub kanały, które w kodzie korzystają
  z tego samego ("ten sam status widzi karta podpisującego i raport"). Tylko miejsca znalezione
  w kodzie, bez przewidywań.
- `risk` (opcjonalnie): jedno nieoczywiste ryzyko, np. istniejące dane.
- `related` (opcjonalnie): inne zgłoszenia, które zmieniały **to samo miejsce w kodzie albo tę
  samą regułę** (`mcp__tracker__list_issues` z `query`); podobny temat nie wystarcza. Najwyżej 3,
  każde w osobnej linii `- ACME-12: dlaczego`, bez tytułu i statusu (tracker pokazuje je w chipie),
  bez innego tekstu. Liczy się `statusType`:
  - otwarte (`backlog`, `unstarted`, `started`): duplikat albo ryzyko kolizji, napisz które;
  - zrobione (`completed`): tylko gdy zmieniało to samo miejsce (Start czyta wtedy jego notatki zmian);
  - `canceled` i `duplicate` pomiń.
  Limit słów sekcji nie obejmuje `related`.

**Decyzje** (`decisions`): tylko pytania, od których zależy zakres, najwyżej 3. Każde ma 2-3
opcje: `label` 1-4 słowa, `desc` najwyżej 8 słów (skutek dla produktu, nie technika),
`recommended: true` na tej jednej, którą polecasz, ustawionej jako pierwsza. Brak decyzji =
pusta lista.

### Tryb Deep

Gdy polecenie zawiera słowo „deep” („tryb deep”, „deep mode”), obowiązują poniższe zmiany. Reszta
skilla bez zmian.

- **Szukanie bez limitu „nie więcej”.** Celem jest pewny werdykt, nie dłuższy tekst:
  - prześledź cały przepływ od początku do końca (ekran → serwer → baza),
  - rozważ co najmniej 2 hipotezy przyczyny, sprawdź obie w kodzie i ustal, czemu słabsza odpada,
  - sprawdź powiązane ścieżki, testy i podobne wzorce,
  - szukaj ryzyk, przypadków brzegowych i tego, co poprawka może zepsuć.
- **Limit sekcji: ok. 500 słów razem** zamiast 180, nadal bez wstępów i powtórzeń. `related`
  najwyżej 5 zgłoszeń zamiast 3.
- `verdict` / `answer`: po przyczynie jedno zdanie o odrzuconej hipotezie i czemu odpada.
  Twierdzenia niesprawdzone w kodzie oznacz „(założenie)”.
- `risk` jest obowiązkowy i może być listą: każde ryzyko i przypadek brzegowy od nowej linii
  zaczynającej się od „- ”.
- Zasada „bez nazw plików i funkcji” dalej obowiązuje: dowody sprawdzasz w kodzie, a w analizie
  opisujesz je nazwami z interfejsu.

Typ sam ustawia etykietę zgłoszenia (Bug / Feature / Investigate), nie podawaj jej osobno.

Przykład wywołania:

```json
{
  "id": "ACME-180",
  "type": "bug",
  "sections": {
    "verdict": "Tak · formularz kontraktu zapisuje się bez daty końca, wymaga jej dopiero zatwierdzenie.",
    "howToCheck": "Kontrakty → Nowy kontrakt → zostaw puste „Do, włącznie” → Zapisz: kontrakt powstaje.",
    "system": "Brak daty to kontrakt bezterminowy na liście, przy przypisywaniu przez operatora i w raporcie.",
    "risk": "Istniejące kontrakty bez daty trzeba uzupełnić przy następnej edycji."
  },
  "decisions": [
    { "question": "Kiedy wymagać daty końca?", "options": [
      { "label": "Przy zapisie", "desc": "nie powstanie kontrakt bez daty", "recommended": true },
      { "label": "Przy zatwierdzeniu", "desc": "szkic może być bez daty" } ] }
  ]
}
```

## Zasady

- **Nie zmieniaj kodu ani statusu zgłoszenia.** Analiza to tylko tekst.
- Bez nazw plików, funkcji i klas, backticków i żargonu (seed, 403, endpoint, API, commit,
  migracja, tenant, nazwy stanów z kodu, nazwy dostawców). Pisz nazwami z interfejsu.
- Przy ponownej analizie (Re-analyze) uwzględnij poprzednią i nowe komentarze i napisz całość od
  nowa. Pytania, na które ktoś już odpowiedział, zostaw w tym samym brzmieniu i z tymi samymi
  nazwami opcji: tracker przeniesie wybór.
- Nie używaj pauzy em dash (—).
- Na koniec podaj użytkownikowi listę przeanalizowanych zgłoszeń, jedno zdanie na każde.
