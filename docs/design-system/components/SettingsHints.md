„Szukasz może?” na dole sekcji Ustawień (`SettingsHints` w `src/web/Settings.tsx`). Zatwierdzone przez Krzysztofa 27.10.2026 (wzór: Android).

- Pod treścią sekcji, odstęp 24 px: nagłówek `.hint` „Looking for something else?”, pod nim 1–3 wiersze `.settings-hint`.
- Wiersz: „→ nazwa ustawienia” po lewej (`text-secondary`, `text-sm`), ścieżka „Ty › Powiadomienia” / „Projekt › Agent AI” po prawej w `.hint`. Hover: `bg-hover` i `text-primary`, jak `nav-item`.
- Klik przełącza sekcję i na 1,6 s podświetla docelową kartę (`.s-card.flash`: obramowanie `accent`) albo wiersz (`.s-row.flash`: tło `bg-hover`). Cel to `id` karty w kodzie.
- Podpowiedź tylko do ustawień w innej sekcji, nigdy do tej samej. Lista w `HINTS`; nowa sekcja ustawień = sprawdź, czy ktoś będzie jej szukał gdzie indziej.
- Niedostępna sekcja (np. Workspace › Konta dla nie-admina): wiersz wyszarzony z powodem w `Tooltip`, nie ukryty.
