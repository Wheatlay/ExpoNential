import { useSyncExternalStore } from 'react';

const subscribe = (fn: () => void) => {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
};

export function usePath() {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Klik w link: lewy przycisk bez modyfikatorów nawiguje w SPA, reszta (ctrl/środkowy) otwiera kartę. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
