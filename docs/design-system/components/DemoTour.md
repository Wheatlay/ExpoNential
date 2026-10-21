Przewodnik po demo (`DemoTour`) i pasek `DemoBanner`; tylko gdy `me.demo`.

- Dymek `.demo-tour`: tło `bg-popover`, `shadow-popover`, `radius-lg`, szerokość do 320 (jak `.popover`). Treść `text-md`, jedno–dwa zdania; stopka: licznik „2 / 5” (`hint`, kolor `ai-text`), „Skip tour”, „Back”, „Next” (`btn sm`, `Next` jako `primary`).
- Dymek przykleja się do elementu z `data-tour="…"` (pod nim, a gdy brak miejsca nad nim; brak elementu: środek ekranu). Cel dostaje obrys `accent` 2 (`[data-tour-on]`).
- Kroki: `analyze`, `analysis`, `start-work`, `activity` (strona zgłoszenia ACME-12) i `review` (Sprint review). Krok widać tylko na swojej stronie; „Next” prowadzi nawigacją.
- Niedostępne „Next” jest wyszarzone z `title` podającym powód („Click Analyze first”), nie ukryte.
- Stan w `localStorage` (`demoTour`: `step`, `done`), z `try/catch`; „Restart tour” w `DemoBanner` zeruje go i otwiera ACME-12.
- `DemoBanner`: pasek `control-sm` nad aplikacją, tło `accent` 14% na `bg-app`, tekst `accent-text`; zawsze widoczny, bez zamykania. Na telefonie tylko pierwszy segment i ikony.
- Animacja wejścia 120 ms, wyłączona przy `prefers-reduced-motion`.
