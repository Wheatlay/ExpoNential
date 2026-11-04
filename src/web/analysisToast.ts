import { queryClient, type IssueDetail, type NotifySettings } from './api.ts';
import { dismissToast, toast } from './toast.ts';

/**
 * Toast "analiza zlecona". Przy włączonym ustawieniu (domyślnie tak) zostaje, aż analiza tego zgłoszenia się skończy albo nie uda się
 * (obserwujemy zapytanie zgłoszenia); inaczej znika po zwykłym czasie. Zabezpieczenie: najdalej po 15 minutach.
 */
export function analysisToast(number: number, text: string) {
  const sticky = queryClient.getQueryData<NotifySettings>(['notify-settings'])?.analysisToastSticky !== false;
  if (!sticky) { toast(text); return; }
  const id = toast(text, 'ok', { sticky: true });
  let seen = false;
  const done = () => { unsub(); clearTimeout(cap); dismissToast(id); };
  // Zaraz po zleceniu cache ma jeszcze stare dane (bez zlecenia): kończymy dopiero po tym, jak zlecenie było widać.
  const check = () => {
    const d = queryClient.getQueryData<IssueDetail>(['issue', number]);
    if (!d) return;
    if (d.analysisRequestedAt && !d.analysisFailedAt) seen = true;
    else if (seen) done();
  };
  const unsub = queryClient.getQueryCache().subscribe((ev) => {
    const k = ev.query.queryKey;
    if (k[0] === 'issue' && k[1] === number) check();
  });
  const cap = setTimeout(done, 15 * 60_000);
}
