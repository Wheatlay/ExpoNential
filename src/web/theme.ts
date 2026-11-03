export type Theme = 'dark' | 'light' | 'oled';

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* prywatne okno */ }
}
