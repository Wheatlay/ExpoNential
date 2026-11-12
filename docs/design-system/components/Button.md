Przycisk akcji; jedyny sposób na wywołanie polecenia poza menu.

- `.btn` (32, `control-md`) domyślnie; `.btn.sm` (28) w paskach narzędzi i wierszach.
- `.btn.primary` tylko dla jednej głównej akcji w widoku (Send, Save). `on-accent` na `accent`.
- `.btn.danger` dla usuwania; w oknie potwierdzenia wypełniony `danger` z `on-accent`.
- `.btn.warn` gdy akcja omija ostrzeżenie (Move to Done anyway). Wyjątek: Move w oknie spotkania jest `.btn.sm.warn` i pojawia się dopiero po ustawieniu innego terminu (bez wyszarzenia), żeby niezapisana zmiana rzucała się w oczy (zatwierdzone 12.11.2026).
- `.ai-btn` dla akcji wykonywanych przez Claude (Analyze, Close in Claude), `.start-btn` dla Start work.
- Niedostępny: `disabled` + `Tooltip` z powodem. Etykieta mówi, co się stanie („Move to Done”), ikona opcjonalna z lewej.
