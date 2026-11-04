Menu kontekstowe i listy wyboru (`.popover`, `bg-popover`, `radius-lg`, `shadow-popover`).

- Wiersz `.menu-item` (36), ikona z lewej w `text-secondary`, skrót z prawej (`.shortcut`), zaznaczenie `.check`.
- Niedostępna pozycja: wyszarzona z podpowiedzią powodu (`aria-disabled` + `disabledReason`), nigdy usunięta.
- Lista z wyszukiwaniem może dodać pozycję z wpisanego tekstu (`dynamic(query)`), np. „Create label "X"”, gdy żadna etykieta nie pasuje dokładnie.
- Usuwanie na dole, `.menu-item.danger`, oddzielone `.menu-sep`.
