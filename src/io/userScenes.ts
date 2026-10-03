/*
 * Scenes the user saves. Settings only (never audio), kept in this browser's
 * localStorage; a failure to read or write is treated as "none saved".
 */
import type { Scene } from '../audio/engine';

const KEY = 'fieldstretcher.scenes';

export function loadUserScenes(): Scene[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is Scene => !!s && typeof s.name === 'string' && Array.isArray(s.tracks) && !!s.fx).map((s) => ({ ...s, user: true })) : [];
  } catch {
    return [];
  }
}

function write(list: Scene[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Save under a name; a scene with the same name is replaced. */
export function saveUserScene(scene: Scene): boolean {
  const name = scene.name.trim().slice(0, 40);
  if (!name) return false;
  const list = loadUserScenes().filter((s) => s.name !== name);
  list.push({ ...scene, name, user: true });
  return write(list);
}

export function deleteUserScene(name: string): boolean {
  return write(loadUserScenes().filter((s) => s.name !== name));
}
