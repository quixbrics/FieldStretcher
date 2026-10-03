import { getTheme } from '../src/ui/theme';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

beforeEach(() => store.clear());

describe('theme', () => {
  it('is dark by default, whatever the phone prefers', () => {
    expect(getTheme()).toBe('dark');
  });
  it('is light only if light was chosen; anything else is dark', () => {
    store.set('scapemaker.theme', 'light');
    expect(getTheme()).toBe('light');
    store.set('scapemaker.theme', 'dark');
    expect(getTheme()).toBe('dark');
    store.set('scapemaker.theme', 'purple');
    expect(getTheme()).toBe('dark');
  });
});
