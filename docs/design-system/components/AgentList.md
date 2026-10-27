Lista komputerów z agentem w Ustawieniach > Claude Code (karta `.s-card` „Your computers”, widoczna po podłączeniu komputera).

- Wiersz `.s-row`: nazwa komputera (`grow`), podpowiedź `.hint` ze stanem („online”, „running an analysis”, „last seen 2 hours ago”, „never seen”), `btn sm danger` „Remove”.
- „Remove” zawsze przez `askConfirm` (nie systemowe `confirm()`), z treścią, że komputer przestaje odbierać zlecenia do ponownej instalacji.
- Ostatni wiersz: `.switch` „This computer has the agent” z podpowiedzią (dla laptopów z dotykiem; wyłączony = Analyze w tej przeglądarce tylko dodaje zlecenie do kolejki). Zapis w `localStorage`, tylko dla tej przeglądarki.
- Karta projektu „Team queue” (ustawienia projektu > AI prompts, pod poleceniami) używa tego samego wiersza dla komputerów online w projekcie: nazwa · właściciel, znacznik „running an analysis” przy zajętym.
- Komputer ze starą wersją skryptów: `.pill.stalled` „Update needed” przy nazwie (z wyjaśnieniem w `title`); ten sam znacznik w wierszu polecenia aktualizacji w karcie podłączenia. Skrypty nie aktualizują się same.
