---
name: analyze-tracker-ticket
description: >
  Robi analizę AI problemu dla zgłoszeń w Trackerze, które ktoś oznaczył przyciskiem "Analyze"
  (flaga analysisRequested). Czyta zgłoszenie i kod repo, zapisuje analizę w sekcjach z decyzjami
  do kliknięcia. Użyj, gdy użytkownik mówi "zrób analizy", "przeanalizuj zgłoszenia",
  "co czeka na analizę", "przeanalizuj ACME-123", albo nazywa skill po imieniu.
---

Wywołaj narzędzie MCP `get_procedure` z `name: "analyze"` i wykonaj zwróconą procedurę dokładnie. Numer zgłoszenia weź z wiadomości użytkownika.
