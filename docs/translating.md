# Translating Exponential

UI strings are English keys in the code: `t('Move to Done')`. The English text is the key, so English needs no file.
The Polish dictionary is `src/web/pl.ts` (key -> translation). Plurals use `tn()` with a `one|other` key.

## Add a language

1. Add a dictionary file next to `pl.ts` (for example `src/web/de.ts`) with the same keys.
2. Register it in `src/web/i18n.ts`: extend the `Lang` type, the `detect()` function (browser language) and the lookup in `t()` / `tn()`.
3. Add the language to the select in Settings > Appearance > Language (`src/web/Settings.tsx`), labelled with its own name.
4. Allow the new code in the server: `lang` in `PUT /api/me` (`src/server/api.ts`) and `src/server/account.ts`.
5. Run `npx vitest run tests/i18n.test.ts` (checks that the dictionary is complete).

The desktop agent window texts live in `agent/internal/app/settings_windows.go`, function `settingsLabels()` (and the
similar label functions for the tray and toasts). The agent follows the language saved on the account.

Open a pull request when done.
