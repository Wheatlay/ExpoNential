Okno potwierdzenia (`askConfirm`) zamiast systemowego `confirm()`; Enter potwierdza, Escape i klik w tło anulują.

- Tytuł jako pytanie z nazwą rzeczy („Delete ACME-11?”), pod nim jedno zdanie skutku.
- Przycisk akcji nazywa akcję („Delete”, „Revoke”, „Cancel meeting”); destrukcyjna: wypełniony `danger`.
- Potwierdzenie z wpisaniem (`type`): pole z placeholderem = tekst do wpisania (np. login przy usuwaniu konta), przycisk akcji wyszarzony, dopóki wpis się nie zgadza; Enter w polu potwierdza tylko przy zgodnym wpisie.
- Bez danger (`danger: false`) dla okna prowadzącego dalej, np. „Connect Claude Code first?” → „Open settings” przy Start work bez podłączonego komputera.
