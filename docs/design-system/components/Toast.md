Krótki komunikat na dole ekranu (`toast()` z `src/web/toast.ts`), `bg-popover`, `radius-lg`, do `100vw - 32`.

- Rodzaje: `ok` (znika po 2,5 s), `err` i `warn` (po 5 s). Tekst w jednej linii, za długi ucięty wielokropkiem, pełny w `title`.
- Trwały (`{ sticky: true }`) zostaje do `dismissToast(id)` albo ✕ (`.icon-btn`). Używa go tylko toast zleconej analizy: wisi do jej końca albo błędu (limit 15 min). W Settings › Notifications da się to wyłączyć, domyślnie włączone. Zatwierdzone 05.11.2026.
