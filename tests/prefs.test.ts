import { defaultAudioPrefs, loadAudioPrefs, saveAudioPrefs } from '../src/io/audioPrefs';
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

describe('audio preferences', () => {
  it('default to the session that is known to record, with the microphone only open while recording', () => {
    expect(defaultAudioPrefs()).toEqual({ session: 'play-and-record', keepMicOpen: false });
    expect(loadAudioPrefs()).toEqual(defaultAudioPrefs());
  });
  it('save and load', () => {
    saveAudioPrefs({ session: 'auto', keepMicOpen: true });
    expect(loadAudioPrefs()).toEqual({ session: 'auto', keepMicOpen: true });
  });
  it('fall back to the defaults for damaged or out-of-range storage', () => {
    store.set('fieldstretcher.audio', '{not json');
    expect(loadAudioPrefs()).toEqual(defaultAudioPrefs());
    store.set('fieldstretcher.audio', JSON.stringify({ session: 'earpiece', keepMicOpen: 'yes' }));
    expect(loadAudioPrefs()).toEqual(defaultAudioPrefs());
    store.set('fieldstretcher.audio', JSON.stringify({ session: 'playback' }));
    expect(loadAudioPrefs()).toEqual({ session: 'playback', keepMicOpen: false });
  });
});
