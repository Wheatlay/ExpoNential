/**
 * Enter zatwierdza, Alt+Enter (albo Shift+Enter) wstawia nową linię.
 * Alt+Enter sam z siebie nie dodaje znaku w textarea, więc wstawiamy go ręcznie.
 */
export function enterToSubmit(e: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void, setValue?: (v: string) => void) {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
  if (e.altKey) {
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const next = value.slice(0, a) + '\n' + value.slice(b);
    if (setValue) setValue(next);
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1; });
    return;
  }
  if (e.shiftKey) return; // natywnie nowa linia
  e.preventDefault();
  submit();
}
