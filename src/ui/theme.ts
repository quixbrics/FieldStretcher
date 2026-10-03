/*
 * Light / dark. Dark unless the user chose light. The choice is stored under the
 * same key the other Maker apps use, so it carries across them on this origin.
 * It is a choice made here: it does NOT follow the phone's own light/dark setting.
 */
export type Theme = 'dark' | 'light';

const KEY = 'scapemaker.theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  // the phone's status bar / browser chrome colour
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f6f8fa' : '#0d1117');
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: it just will not be remembered */
  }
  applyTheme(t);
}
