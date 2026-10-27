Mała etykieta stanu na karcie i w nagłówkach (22 px, `radius-full`, `text-sm`).

- Neutralna `.pill`; stan przez modyfikator: `.ai` (analiza w toku, pulsuje), `.ai.done`, `.notes-missing` (warning), `.question` / `.question.me` (warning, pełne gdy pytanie do mnie), `.unread` (info), `.blocked` (danger).
- `.stalled` (warning): analiza utknęła (claim agenta bez sygnału życia ponad 15 minut, „Stalled”) albo czeka na komputer, którego nikt nie słucha („Waiting for a PC”). Tekst mówi, który z dwóch przypadków, `title` wyjaśnia, co zrobić.
- Stan analizy to jedna pigułka w nagłówku sekcji: `.ai` „Waiting · 2 min ago” (jest online komputer, który ją weźmie), `.ai` „Running on {komputer} · 1 min ago” (zlecenie przejęte), `.stalled` jak wyżej. Przy Deep po nazwie stanu dopisek „· Deep”.
- Zawsze słowo lub liczba w środku; sama ikona tylko z `.icon-only` i `title`.
- Neutralna `.pill` „Team queue” na pasku analizy zgłoszenia: widoczna tylko, gdy projekt ma włączoną kolejkę zespołu (domyślnie wyłączona), z wyjaśnieniem w `title`.
- `.pill.stalled` „Update needed” z `role="button"` na pasku analizy, gdy mój PC ma stare skrypty; klik prowadzi do Ustawień > Claude Code. Analyze, Deep i Start on my PC są wtedy wyszarzone z powodem (serwer i tak nie wyda pracy starym skryptom).
