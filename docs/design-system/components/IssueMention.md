Wzmianka o zgłoszeniu w tekście (opis, komentarz, analiza AI, notatki zmian), wzorem Lineara.

- Identyfikator w Markdownie sam staje się wzmianką (`Markdown.tsx`): tylko klucze istniejących projektów, dowolna wielkość liter, z myślnikiem, spacją albo bez (`CHUB-172`, `chub 172`, `chub172`). W kodzie (`` `ACME-12` ``), w istniejącym linku i w gołym adresie zostaje bez zmian.
- Pod polem edycji (opis, komentarz, odpowiedź, nowe zgłoszenie) `MentionHint` pokazuje „Links to” i rozpoznane wzmianki jeszcze przed zapisem; te chipy są tylko podglądem (`span`, klik nie zabiera z edycji).
- Wygląd: `.issue-mention`, w linii z tekstem: ikona statusu 12, id w `text-secondary` (450), tytuł w `text-primary` ucięty wielokropkiem. Ramka `border-secondary`, tło `bg-secondary`, najechanie `bg-hover`, `radius-sm`.
- Podpowiedź (`title`): nazwa statusu i pełny tytuł, bo stan nie może być tylko ikoną.
- Klik nawiguje w aplikacji (`linkProps`); środkowy przycisk i Ctrl+klik otwierają nową kartę (przeglądarka, prawdziwy `href`).
- Prawy przycisk: menu aplikacji jak przy podzadaniu (Open, Open in new tab, Status, Priority, Assignee, Copy ID, Copy link). Na stronie innego zgłoszenia także Add relation z gotowymi zdaniami („CHUB-191 waits on CHUB-19”, „… blocks …”, „… is related to …”), bez wyszukiwarki.
- Zgłoszenie z innego projektu albo spoza listy: zwykły link z samym id.
