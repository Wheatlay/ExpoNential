Lista w karcie Ustawień (`.s-card` + wiersze `.s-row`), np. Projekt › Ludzie, Link zaproszenia, Workspace › Konta. Zatwierdzone przez Krzysztofa 28.10.2026.

- Nagłówek karty to `.s-row.s-row-head`: tło `bg-tertiary` (pierwszy wiersz ma górne rogi `radius-lg` karty), tytuł pogrubiony, opis w `.hint` pod nim, akcje tworzenia (np. „Utwórz link zaproszenia”, „Wpuść”) po prawej. Nagłówek nie może wyglądać jak pozycja listy.
- Wiersz pozycji: po lewej nazwa w `.grow`, pod nią druga linia (stan jako `.pill` z karty Pill w `.s-meta`: odstęp 4 px od nazwy i między pigułkami, albo szczegóły w `.hint`); po prawej kontrolki i przyciski `.btn.sm`.
- Ten sam zestaw przycisków w każdym wierszu i w tej samej kolejności, żeby kolumny się nie rozjeżdżały. Akcja bez sensu dla danej pozycji jest wyszarzona z powodem w `Tooltip`, nigdy ukryta.
- Mój wiersz ma `.badge.me` „Ty” obok nazwy.
- Daty w wierszach `dd.mm.rrrr`.
- Układ Ustawienia › Moje AI (zatwierdzony 04.11.2026): dwie karty. „AI clients” (nagłówek z przyciskiem „Connect another”, albo „Connect AI” `primary` gdy pusto; pusta lista = `.hint` „No AI client connected”), pod wierszami klientów zwinięty `<details>` „API keys (n)” z tymi samymi wierszami (nazwa, utworzono/użyto, Revoke). „Your PCs” zawsze widoczna (pusta: `.hint` „No PC with the agent” + `btn primary` „Connect this PC”). Karty „Connected AI clients” i osobnej karty kluczy API nie ma.
