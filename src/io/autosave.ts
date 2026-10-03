/*
 * Keeps the session in IndexedDB so a reload (or iOS discarding the page)
 * does not lose the recordings. Settings are saved on every change (debounced);
 * a track's audio only when that track's audio changed. Everything fails
 * quietly — private browsing or a full disk must never break the app.
 */
import type { Engine, ProjectData } from '../audio/engine';

const DB = 'fieldstretcher';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function put(entries: [string, unknown][]): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const [k, v] of entries) tx.objectStore(STORE).put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  const v = await new Promise<T | undefined>((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return v;
}

export interface Saved {
  project: ProjectData;
  audio: (Float32Array | null)[];
  sampleRate: number;
}

export async function loadSaved(): Promise<Saved | null> {
  try {
    const project = await get<ProjectData>('project');
    if (!project) return null;
    const audio: (Float32Array | null)[] = [];
    for (let i = 0; i < 4; i++) audio.push((await get<Float32Array>(`audio${i}`)) ?? null);
    return { project, audio, sampleRate: project.sampleRate };
  } catch {
    return null;
  }
}

export async function clearSaved(): Promise<void> {
  try {
    await put([['project', undefined], ['audio0', undefined], ['audio1', undefined], ['audio2', undefined], ['audio3', undefined]]);
  } catch {
    /* nothing to clear */
  }
}

export function attachAutosave(engine: Engine, delayMs = 900) {
  const dirty = new Set<number>();
  let timer = 0;
  const flush = async () => {
    const entries: [string, unknown][] = [['project', engine.getProject()]];
    for (const i of dirty) entries.push([`audio${i}`, engine.audio[i]]);
    dirty.clear();
    try {
      await put(entries);
    } catch {
      /* quota or private mode: keep working without a safety net */
    }
  };
  engine.onChange((audioTrack) => {
    if (audioTrack !== undefined) dirty.add(audioTrack);
    window.clearTimeout(timer);
    timer = window.setTimeout(flush, delayMs);
  });
  // iOS may drop the page when it is backgrounded: save right away then
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      window.clearTimeout(timer);
      void flush();
    }
  });
}
