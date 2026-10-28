---
name: close-ticket
description: >
  Zamyka temat w Trackerze (ACME-*): wypełnia na zgłoszeniu dwa pola opisu zmian, krótkie
  "HUMAN" w języku zgłoszenia (do zatwierdzenia/przeredagowania przez użytkownika przed zapisem) i
  szczegółowe techniczne "AI" dla przyszłego agenta (commity, pliki, powody, weryfikacja),
  zapisywane od razu bez potwierdzenia. Oba pola są wymagane, żeby przenieść zadanie do Done.
  Użyj, gdy użytkownik mówi "zamknij taska", "podsumuj to w trackerze", "zamknijmy tak jak
  zawsze zamykamy taska", "zrób tak jak przy [numer]", albo nazywa skill po imieniu. Uruchamiaj
  też, gdy kończy się większy kawałek pracy nad zgłoszeniem i trzeba zostawić ślad dla
  człowieka i dla następnego agenta AI.
---

Wywołaj narzędzie MCP `get_procedure` z `name: "close"` i wykonaj zwróconą procedurę dokładnie. Numer zgłoszenia weź z wiadomości użytkownika.
