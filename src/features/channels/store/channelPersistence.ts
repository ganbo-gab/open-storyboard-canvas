import type { StateStorage } from 'zustand/middleware';

const transient = new Map<string, string>();
let warnedUnavailable = false;

/** Always supplies a real Zustand storage boundary, including Node/SSR.
 * With no browser storage, state is intentionally process-local. Resolve storage
 * per operation so browser hydration and injected test storage remain real.
 */
export const channelPersistenceStorage = {
  getItem(name: string): string | null {
    const storage = availableBrowserStorage();
    return storage ? storage.getItem(name) : transient.get(name) ?? null;
  },
  setItem(name: string, value: string): void {
    const storage = availableBrowserStorage();
    if (storage) storage.setItem(name, value);
    else transient.set(name, value);
  },
  removeItem(name: string): void {
    const storage = availableBrowserStorage();
    if (storage) storage.removeItem(name);
    else transient.delete(name);
  },
} satisfies StateStorage;

function availableBrowserStorage(): Storage | undefined {
  let storage: Storage | undefined;
  try { storage = typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch (error) {
    if (!warnedUnavailable) {
      console.warn('[Channels] Browser storage unavailable; channels are process-local.', error instanceof Error ? error.name : 'storage access denied');
      warnedUnavailable = true;
    }
  }
  if (!storage && typeof window !== 'undefined' && !warnedUnavailable) {
    console.warn('[Channels] Browser storage unavailable; channels are process-local.');
    warnedUnavailable = true;
  }
  return storage;
}
