Pole tekstowe (`.input`, 32, `radius-md`, `bg-primary`); fokus zmienia ramkę na `accent`.

- Etykieta obok albo nad polem; placeholder w `text-quaternary` to przykład, nie etykieta.
- Daty i godziny tylko przez `DateInput` (dd.mm.rrrr + kalendarz) i `TimeInput` (24 h, dwie kolumny: godziny i minuty co 5 ze stałym pasem wyboru na środku; klik wybiera od razu, po przewinięciu kółkiem, przeciąganiem albo palcem wybiera się to, co stanęło w pasie), nigdy `<input type="date|time">`.
- Wpisywanie działa zawsze, separator (`:` / `.`) wstawia się sam. Godzina otwiera listę przy fokusie; data otwiera kalendarz tylko z ikony (systemowy kalendarz przejmuje klawiaturę).
- Wpis, którego nie da się odczytać: ramka `danger` już w trakcie pisania (`.input.invalid`), przy zatwierdzeniu wraca poprzednia wartość z komunikatem (toast). Nigdy cicho.
- Wybór z kilku opcji: `.seg` (segmentowy) albo menu; przełącznik tak/nie: `.switch`.
