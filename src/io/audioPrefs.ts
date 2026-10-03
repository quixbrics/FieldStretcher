/*
 * How the phone's audio session behaves. Kept in localStorage; unreadable or
 * missing storage just means the defaults.
 */

/**
 * What iOS is told while the microphone is open (while recording). When the microphone is closed the
 * session is always plain playback, which uses the main speaker.
 *  play-and-record the call-style session: known to record on every iPhone (the default); sound may
 *                  go to the earpiece for the length of the take
 *  playback        try to keep playing through the main speaker while recording; on some iOS
 *                  versions a take made this way comes out silent
 *  auto            leave it to the browser
 */
export type SessionMode = 'playback' | 'play-and-record' | 'auto';

export interface AudioPrefs {
  session: SessionMode;
  /** keep the mic open all the time (an always-on input meter) instead of only while recording */
  keepMicOpen: boolean;
}

const KEY = 'fieldstretcher.audio';
export const defaultAudioPrefs = (): AudioPrefs => ({ session: 'play-and-record', keepMicOpen: false });

export function loadAudioPrefs(): AudioPrefs {
  const d = defaultAudioPrefs();
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AudioPrefs>;
    return {
      session: r.session === 'playback' || r.session === 'play-and-record' || r.session === 'auto' ? r.session : d.session,
      keepMicOpen: typeof r.keepMicOpen === 'boolean' ? r.keepMicOpen : d.keepMicOpen,
    };
  } catch {
    return d;
  }
}

export function saveAudioPrefs(p: AudioPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}
