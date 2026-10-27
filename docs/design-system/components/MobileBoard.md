Board na telefonie (`src/web/MobileBoard.tsx`). Zatwierdzone przez Krzysztofa (kierunek A + C, Fold 6).

- Złożony telefon (≤760 px): zakładki statusów w `.seg` (przewijane w poziomie, licznik `text-tertiary`), jeden status naraz.
  Przesunięcie palcem w lewo/prawo zmienia zakładkę.
- Rozłożony składak / tablet (600–1100 px i dotyk): `.split-board`, lista po lewej (320), otwarte zgłoszenie po prawej.
  Statusy zamknięte (completed, canceled, duplicate) są zwinięte; nagłówek `.m-head` je rozwija.
- Wiersz `.m-row` (48, nie kontrolka): priorytet, id (`text-sm`, `text-tertiary`), tytuł w jednej linii, awatar 20.
  Wybrany/wciśnięty `bg-active`.
- Przytrzymanie wiersza otwiera `Menu` jako arkusz od dołu (`.popover.sheet`, `radius-xl` u góry, pozycje `control-lg`):
  statusy, „Assign to me”, „Open”.
