import { externalizeAssetMedia, readWorkspaceRecord, writeWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import type { LocalDocument, LocalStorageStatus } from './workbenchPersistence';

/** IndexedDB documents avoid origin-wide localStorage quota and retain synchronous store actions after hydration. */
export function createWorkspaceDocument<T>(key: string, initial: () => T, validate: (input: unknown) => T): LocalDocument<T> {
  let value = initial();
  let status: LocalStorageStatus = { mode: 'persistent' };
  let initialized: Promise<void> | undefined;
  let pending = Promise.resolve();
  let failure: unknown;
  let writable = true;
  let hydrated = false;
  const initialize = (): Promise<void> => {
    if (!initialized) initialized = (async () => {
      try {
        let envelope = await readWorkspaceRecord<{ version: number; data: unknown }>('documents', key);
        if (!envelope) {
          // Migration is read-only with respect to legacy storage, including malformed values.
          let raw: string | null = null;
          try { raw = globalThis.localStorage?.getItem(key) ?? null; } catch { /* IndexedDB works independently of blocked localStorage. */ }
          if (raw) envelope = JSON.parse(raw);
        }
        if (envelope) {
          if (envelope.version !== 1) throw new Error('Unsupported stored version; existing data preserved');
          value = validate(envelope.data);
        }
        value = await externalizeAssetMedia(value, true);
        await writeWorkspaceRecord('documents', key, { version: 1, data: value });
      } catch (error) {
        failure = error; writable = false;
        status = { mode: 'memory', reason: error instanceof Error ? error.message : 'IndexedDB storage unavailable' };
      } finally {
        hydrated = true;
      }
    })();
    return initialized;
  };
  return {
    initialize,
    load: () => value,
    save(next) {
      if (!hydrated) throw new Error('Initialize the workspace document before saving a full snapshot');
      value = next;
      const snapshot = structuredClone(next);
      pending = pending.then(async () => {
        await initialize();
        if (!writable) return;
        try {
          const persisted = await externalizeAssetMedia(snapshot, true);
          await writeWorkspaceRecord('documents', key, { version: 1, data: persisted });
          failure = undefined;
          status = { mode: 'persistent' };
        } catch (error) {
          failure = error;
          status = { mode: 'memory', reason: error instanceof Error ? error.message : 'IndexedDB write failed' };
        }
      });
    },
    async flush() {
      await initialize();
      await pending;
      if (failure) throw failure;
    },
    status: () => status,
  };
}
