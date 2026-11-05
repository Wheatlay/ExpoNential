Okno „Report a bug or idea” (`src/web/Feedback.tsx`). Wzór jak okno nowego zadania (NewIssue): `.backdrop` + `.modal`, Esc zamyka, Ctrl/Cmd+Enter wysyła. Zatwierdzone przez Krzysztofa 05.11.2026 (zakres zlecenia).

- Wejście: `.icon-btn` z `Icon.flag` obok dzwonka w nagłówku (`Tooltip` „Report a bug or idea”) i polecenie w Ctrl+K. Wyłączone, nigdy ukryte: w demo „Disabled in the demo”, bez wybranego projektu „Not set up yet. A workspace admin chooses the project in Settings.” (polecenie w Ctrl+K pokazuje wtedy ten powód w toaście).
- Układ: `.crumbs` z `.seg` (Bug / Idea), `input.title`, `textarea`, `Attachments` (wklejone obrazki jak w opisie zadania, `useAttachments`), `.foot`: `.hint` (dla Bug: „Page, browser and app version are attached.”, dla Idea: podpowiedź klawiszy z `keyHint('send')`), „Cancel”, `btn primary` „Send”.
- Enter/Alt+Enter wg ustawienia „Enter sends” (`enterToSubmit`). Po wysłaniu toast „Sent. Thanks!” i zamknięcie; zgłaszający nie dostaje numeru ani linku zadania.
- Zgłoszenie trafia do projektu z Ustawienia › Workspace › „Bug reports and ideas go to” (`select.input` w `.s-card`, tylko admin workspace, opcja „None”).
- Kalendarz (ankiety, 05.11.2026): opcja ankiety, której czas minął, i wygasła ankieta są przygaszone (`opacity` 0.5 jak odpowiedziana opcja) w kalendarzu i w oknie ankiety (`.past`), z `Tooltip` „This time has already passed” / „All proposed times have passed”; panel boczny ma grupę „Ready to pick” z `btn sm primary` „Pick time”.

Przycisk w nagłówku: `.icon-btn.feedback-btn`, ikona flagi w kolorze `--danger` (wyłączony: `--text-quaternary`). Zatwierdzone 05.11.2026.
