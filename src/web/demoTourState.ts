import { navigate } from './router.ts';

export const TOUR_ISSUE = '/issue/ACME-12';
export const TOUR_RESTART = 'demo-tour-restart';

/** Przewodnik od początku i na stronie zgłoszenia ACME-12. Stan trzyma DemoTour (ładowany osobno), tu tylko sygnał. */
export function restartTour() {
  window.dispatchEvent(new Event(TOUR_RESTART));
  navigate(TOUR_ISSUE);
}
