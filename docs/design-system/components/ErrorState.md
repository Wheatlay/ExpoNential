Stan widoku, gdy dane się nie wczytały albo jeszcze się wczytują (`src/web/states.tsx`). Zatwierdzone 03.11.2026.

- `ErrorState`: blok z `role="alert"`, padding 24, odstęp 12, wyrównany do lewej. Kolejno: pogrubiony tytuł „Could not load this view”, komunikat błędu w `.hint`, przycisk `.btn` „Retry” (ponawia zapytanie). Bez ikon i ilustracji.
- Używany zamiast pustego ekranu albo mylącego tekstu: tablica (zgłoszenia lub meta się nie wczytały), strona zgłoszenia (każdy błąd poza 404; 404 zostaje „{id} not found”), start aplikacji (błąd `/api/me` inny niż 401; 401 = ekran logowania).
- `LoadingState`: sam napis „Loading…” w `.hint`, padding 24, `aria-busy`. System nie ma szkieletów; nie dodawaj ich bez zgody.
- Pusty stan (brak danych, nie błąd) to ten sam układ bez `role="alert"`: tytuł, `.hint` z wyjaśnieniem i akcja, jeśli jest (np. Sprint review bez sprintu: komunikat + wybór sprintu).
