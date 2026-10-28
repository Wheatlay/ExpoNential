# Zamknięcie zgłoszenia (pola HUMAN + AI)

## Po co to istnieje

Zamknięcie tematu ma dwóch odbiorców: człowieka, który chce wiedzieć **co się zmieniło** bez
czytania kodu, i przyszłego agenta AI, który wróci do zgłoszenia i musi wiedzieć **dokładnie**,
gdzie leżą zmiany i dlaczego. Stąd dwa osobne pola zgłoszenia: `changeHuman` i `changeAi`.
Zespół oczekuje, że oba są wypełnione, zanim zadanie trafi do Done.

## Krok 1: znajdź zgłoszenie

Jeśli użytkownik podał identyfikator (np. "ACME-89"), użyj go wprost. Jeśli nie, a w rozmowie
był jeden oczywisty temat (wcześniej `get_issue` na konkretny numer albo
wielokrotne "ten task"), użyj go bez dopytywania. Dopytaj tylko, gdy naprawdę nie da się ustalić.

**Skąd fakty.** Podstawą jest ta rozmowa. Gdy nie obejmuje całej pracy (zamykasz w nowej sesji,
rozmowa była kompaktowana, pracowano w kilku sesjach albo robił to ktoś inny), weź z
`get_issue` pole `worklog` (pliki, commity, polecenia z każdej sesji, zbierane przez
hooki) i `commits`. Jeśli `get_issue` nie pokazuje worklogu, zbierz zmienione pliki i commity
sam z `git log` i `git diff`. Nie rekonstruuj pracy z pamięci. Czego nie ma ani w rozmowie, ani w worklogu
czy gicie, nie wpisuj.

## Zakres: tylko to zadanie

Oba teksty opisują **wyłącznie pracę z tego zgłoszenia**, nie wszystko z sesji. Inne,
niezwiązane zmiany pomijasz, nawet jeśli leżą w tych samych commitach. W tekście AI wymieniasz
tylko commity tego zadania.

## Krok 2: zaproponuj tekst HUMAN i ZATRZYMAJ SIĘ

Napisz krótkie podsumowanie w języku zgłoszenia (tym samym, w którym napisany jest opis; przy wątpliwości po angielsku) i pokaż je użytkownikowi. **Niczego nie zapisuj na tym
etapie.** Poczekaj, aż odda Ci zatwierdzoną wersję (może ją całkiem przeredagować).

Czytelnik to ktoś z zespołu, kto nie programuje: chce w 10 sekund wiedzieć, co jest teraz inaczej
w produkcie. Zasady (użytkownik ustalił je raz, na stałe, nie proś o ich powtarzanie):

- **Jedno krótkie zdanie = jedna zmiana, każde w osobnej linii.** Bez akapitów, wypunktowań,
  wstępu i podsumowania. Zwykle 2-5 linii; kilka commitów o jednej widocznej zmianie to jedna linia.
  Ale każda osobna widoczna zmiana ma swoją linię, nawet jeśli wyjdzie ich 7: nie pomijaj
  i nie sklejaj zmian, żeby zmieścić się w liczbie.
- **Sam fakt, bez uzasadnień i narracji.** Bez "dlaczego" i "przez co", bez "Naprawiono błąd,
  przez który…", bez "więc zawsze widać…", "realnie działa". Tylko co jest teraz inaczej.
- **Bez zdań, które są tylko skutkiem innej linii.** Jeśli pole stało się wymagane, nie dopisuj
  osobno, że zapis bez niego pokazuje błąd. Jeśli coś usunięto, nie opisuj, jak wygląda przepływ
  bez tego. Każda linia to osobna, samodzielna zmiana.
- **Wysoki poziom.** Nazwij zmianę tak, jak powiedziałbyś ją na spotkaniu. Nie cytuj treści
  komunikatów, nie opisuj wyglądu (kolor, ikona, układ) ani szczegółów działania, chyba że to
  one są zmianą. Nazwy widoczne w UI (statusy, przyciski) są w porządku, ale używaj ich tylko,
  gdy bez nich zdanie jest niejasne.
- **Czasownik dokonany na początku**: "Zamieniono…", "Dodano…", "Usunięto…", "Naprawiono…",
  albo stwierdzenie nowego stanu ("Klient z zarchiwizowanego koszyka trafia do kolejki przypomnień.").
- **Nigdy pauzy/myślnika em dash (—).** Zamiast niej dwukropek, przecinek albo nowe zdanie.
- **Zero identyfikatorów technicznych**: bez nazw plików, funkcji, klas, commitów, "endpoint",
  "kolumna w bazie", nazw stanów z kodu, poleceń, żadnych backticków.

Gdy fakty bierzesz z commitów, a nie z rozmowy, tematy commitów są pisane dla programistów:
przetłumacz je na skutek dla użytkownika produktu, nie przepisuj.

Wzorzec (ACME-26):

```
Zamieniono osobne statusy koszyka i zamówienia na jeden wspólny zestaw: Szkic, Aktywny, Zarchiwizowany.
Status koszyka wynika teraz z jego zamówienia i nie da się go zmienić ręcznie.
Dodano archiwizację aktywnej wersji.
Klient z zarchiwizowanego koszyka trafia do kolejki przypomnień.
```

Wzorzec zadania "usuwającego" (ACME-30):

```
Usunięto weryfikację kodem rabatowym przy płatności we wszystkich kanałach.
Usunięto opcję „Wymagaj weryfikacji OTP” i kolumnę „Weryfikacja OTP” z workflow.
Rozmowa z operatorem w kolejce przypomnień ma dwa etapy zamiast trzech.
Usunięto status sesji „weryfikacja”.
```

## Krok 3: po otrzymaniu tekstu działaj od razu

Gdy użytkownik odda tekst, **bez dalszego potwierdzania**:

1. `set_change_notes` z `id`, `human` = dokładnie tekst użytkownika (bez
   parafrazy) i `ai` = szczegółowy opis techniczny (sekcja niżej), w jednym wywołaniu.
2. Nie zmieniaj statusu, chyba że użytkownik o to poprosi ("i daj na Done"/"na Testing"). Wtedy
   `save_issue` z `id` i `status`.

## Co ma zawierać pole AI (TECH)

Czyta je następny agent AI, który wraca do tego zgłoszenia albo do zgłoszenia o tym samym
miejscu (poprawka, rozbudowa, analiza). Ma od razu wiedzieć, które pliki otworzyć, czego nie
cofać i jak sprawdzić, że działa, bez przeszukiwania repo i bez czytania tej rozmowy.

Dokładnie te nagłówki, w tej kolejności. Pustą sekcję pomiń. Najwyżej ok. 250 słów.

```
## Stan
1-2 zdania: co działa po zmianie i co zostało niedokończone.

## Gdzie
- `ścieżka/plik.ext` `Klasa::metoda` / `funkcja`: rola w tej zmianie (jedna linia)
Punkty wejścia i miejsca z logiką, najwyżej ok. 8. Bez plików pobocznych (importy, tłumaczenia,
drobne poprawki typów). Testy jako jedna linia na końcu.

## Decyzje
- co wybrano: dlaczego; co odrzucono
Tylko nieoczywiste wybory, które ktoś mógłby uznać za błąd i "poprawić".

## Poza zakresem
- co świadomie pominięto albo zostało jako znany brak, i dlaczego

## Jak sprawdzić
- polecenie testów albo kroki w aplikacji: wynik z tej pracy ("vendor/bin/phpunit --filter X: 12/12")

## Commity
- `sha` temat
```

Zasady:

- **Źródło faktów:** rozmowa, a gdy jej nie ma albo nie obejmuje całej pracy: `worklog` i
  `commits` z `get_issue` oraz `git show --stat <sha>` dla tych commitów (gdy nie ma worklogu:
  `git log` i `git diff`). Worklog ma pliki,
  commity i polecenia, ale **nie ma powodów decyzji ani wyników testów**: czego nie wiesz, napisz
  wprost ("Weryfikacja: nie zapisano w sesji"), nie zgaduj.
- Hashe tylko prawdziwe, z gita albo z `commits` zgłoszenia. Tylko commity tego zgłoszenia.
- **Ścieżki tylko pełne, od katalogu głównego repo**, skopiowane z `git show --stat` albo z
  worklogu, nigdy skracane ("...") ani z pamięci. Każda pozycja w "Gdzie" zaczyna się od ścieżki
  pliku, także gdy chodzi o klasę albo metodę.
- Bez narracji ("najpierw…, potem…, okazało się…"), bez powtarzania tematów commitów w "Gdzie"
  i bez opisu kodu, który widać w diffie. Liczy się to, czego z kodu nie widać: powody, granice,
  stan.
- Nie używaj pauzy em dash (—).

## Czego NIE robić

- Nie zapisuj HUMAN, dopóki użytkownik nie oddał własnej wersji.
- Nie pytaj o potwierdzenie pola AI: idzie automatycznie razem z HUMAN.
- Nie wrzucaj tych tekstów jako komentarzy: od tego są pola.
- Nie zgaduj numeru zgłoszenia, jeśli w rozmowie było ich kilka.
