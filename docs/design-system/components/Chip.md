Pigułka filtra albo przełącznika zakresu w pasku narzędzi boardu (28, `radius-full`).

- `.chip` neutralny, `.chip.on` wybrany (`bg-active`).
- `.chip.unread` (info) i `.chip.ask` (warning) mają licznik `<b>` na pełnym wypełnieniu.
- Akcja wewnątrz chipa (`.chip-action`, np. ✓ „Mark all as read”) to osobny przycisk z `aria-label`.
- Chip widoku: `.view-chip` „Default view”, `.view-chip.mine` „My view” w kolorze akcentu.
- Niedostępny chip (`.chip:disabled`, `.prop-chip:disabled`): `opacity: 0.5`, `cursor: not-allowed`, jak `.btn:disabled`; powód w `Tooltip`.
- Chip etykiety na stronie zgłoszenia (`.label-chip`): ✕ `.label-x` usuwa etykietę od razu, bez potwierdzenia (łatwo cofnąć przez +). Z myszką ✕ pojawia się po najechaniu (i przy fokusie z klawiatury) nad prawym końcem chipa, na tle chipa, więc szerokość się nie zmienia; na dotyku stoi w chipie zawsze widoczny.
