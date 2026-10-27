Wzmianka o zgłoszeniu w tekście (opis, komentarz, analiza AI, notatki zmian), wzorem Lineara.

- Goły identyfikator `ACME-12` w Markdownie sam staje się wzmianką (`Markdown.tsx`); w kodzie (`` `ACME-12` ``) i w istniejącym linku zostaje bez zmian.
- Wygląd: `.issue-mention`, w linii z tekstem: ikona statusu 12, id w `text-secondary` (450), tytuł w `text-primary` ucięty wielokropkiem. Ramka `border-secondary`, tło `bg-secondary`, najechanie `bg-hover`, `radius-sm`.
- Podpowiedź (`title`): nazwa statusu i pełny tytuł, bo stan nie może być tylko ikoną.
- Klik nawiguje w aplikacji (`linkProps`); środkowy przycisk i Ctrl+klik otwierają nową kartę (przeglądarka, prawdziwy `href`).
- Prawy przycisk: menu aplikacji jak przy podzadaniu (Open, Open in new tab, Status, Priority, Assignee, Copy ID, Copy link).
- Zgłoszenie z innego projektu albo spoza listy: zwykły link z samym id.
