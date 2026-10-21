Analiza AI w sekcjach i decyzja do kliknięcia (`AnalysisView.tsx`), w panelu `.panel.ai` na stronie zgłoszenia.

- Sekcja: nagłówek `.desc-label` + tekst `text-md`. Pustych sekcji nie ma w ogóle.
- Decyzja: pytanie `text-md` 500, po prawej kto i kiedy wybrał (`text-xs`, tertiary). Opcje `.decision-opt` jak radio na całą szerokość (`radius-md`, `border-secondary`); wybrana `.on`: obwódka i kropka `--ai`, tło 10% `--ai`. Polecana ma `.badge.ai` „Polecane”.
- Ponowny klik w wybraną opcję cofa wybór. „Inne…” otwiera pole `.input` z Zapisz/Anuluj; zapisana odpowiedź to zaznaczona opcja „Inne” z tekstem jako opisem, klik otwiera ją do zmiany (Zapisz/Wyczyść). Escape zamyka pole.
- W trakcie zapisu opcje są `disabled` (kursor `progress`), nie znikają.
