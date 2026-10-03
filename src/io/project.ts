/*
 * .fieldstretcher files: a plain (store-only) ZIP holding project.json and each
 * track's loop as a 24-bit WAV (the Bounce track is stereo). Rename it to .zip and
 * the sounds are right there; open it in the app and everything comes back.
 *
 *   project.json, loops/track1.wav, loops/track2.wav, loops/bounce.wav
 *
 * Files from the four-track version (loops/track1–4.wav) still open: tracks 1 and 2
 * come across, the Bounce track starts empty.
 */
import { makeZip, readZip } from './zip';
import { encodeWav, parseWav } from '../audio/wav';
import { TRACKS, type Loop, type ProjectData } from '../audio/engine';

const fileFor = (i: number): string => (i === TRACKS - 1 ? 'loops/bounce.wav' : `loops/track${i + 1}.wav`);

export async function packProject(p: ProjectData, loops: (Loop | null)[]): Promise<Blob> {
  const files: { name: string; data: Blob | string }[] = [{ name: 'project.json', data: JSON.stringify(p, null, 2) }];
  loops.forEach((l, i) => {
    if (l) files.push({ name: fileFor(i), data: encodeWav(l, p.sampleRate, 24) });
  });
  return makeZip(files);
}

export function unpackProject(buf: ArrayBuffer): { project: Partial<ProjectData>; loops: (Loop | null)[]; sampleRate: number } {
  const files = readZip(buf);
  const pj = files.get('project.json');
  if (!pj) throw new Error('This is not a FieldStretcher project (no project.json inside).');
  let project: Partial<ProjectData>;
  try {
    project = JSON.parse(new TextDecoder().decode(pj));
  } catch {
    throw new Error('The project file is damaged (project.json is unreadable).');
  }
  if (project.app !== 'FieldStretcher') throw new Error('This is not a FieldStretcher project.');
  const loops: (Loop | null)[] = Array(TRACKS).fill(null);
  let sampleRate = typeof project.sampleRate === 'number' ? project.sampleRate : 48000;
  for (let i = 0; i < TRACKS; i++) {
    // a version-1 file's third track is not the Bounce track
    const name = project.v === 1 && i === TRACKS - 1 ? null : fileFor(i);
    const w = name ? files.get(name) : undefined;
    if (!w) continue;
    const wav = parseWav(w);
    loops[i] = wav.channels.slice(0, 2);
    sampleRate = wav.sampleRate;
  }
  return { project, loops, sampleRate };
}

/** Hand a file to the phone's share sheet (Save to Files, AirDrop …), or download it where that is not available. */
export async function shareOrDownload(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      // anything else: fall through to a plain download
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

export const stamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
