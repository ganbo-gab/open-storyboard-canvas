export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord extends ProjectSummaryRecord {
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
  imagePoolJson?: string | null;
  imagePool?: string[] | null;
}

export interface WebProjectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type WebProjectStorageFallbackReason =
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'invalid-data'
  | 'unsupported-version';

export type WebProjectStorageStatus =
  | { mode: 'pending' }
  | { mode: 'persistent' }
  | { mode: 'memory'; reason: WebProjectStorageFallbackReason };

export interface WebProjectStateAdapter {
  listProjectSummaries: () => Promise<ProjectSummaryRecord[]>;
  getProjectRecord: (projectId: string) => Promise<ProjectRecord | null>;
  upsertProjectRecord: (record: ProjectRecord) => Promise<void>;
  updateProjectViewportRecord: (projectId: string, viewportJson: string) => Promise<void>;
  renameProjectRecord: (projectId: string, name: string, updatedAt: number) => Promise<void>;
  deleteProjectRecord: (projectId: string) => Promise<void>;
  getStorageStatus: () => WebProjectStorageStatus;
}


interface CreateWebProjectStateAdapterOptions {
  storage?: WebProjectStorage | null | (() => WebProjectStorage | null);
  storageKey?: string;
  onStatusChange?: (status: WebProjectStorageStatus) => void;
  indexedDB?: IDBFactory | null;
  databaseName?: string;
}

export const WEB_PROJECT_STATE_STORAGE_KEY = 'storyboard-copilot:web-project-state';
const WEB_PROJECT_STATE_VERSION = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isNullableStringArray(value: unknown): value is string[] | null | undefined {
  return value === undefined
    || value === null
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!isPlainRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt)
    && isFiniteNumber(value.nodeCount)
    && typeof value.nodesJson === 'string'
    && typeof value.edgesJson === 'string'
    && typeof value.viewportJson === 'string'
    && typeof value.historyJson === 'string'
    && isNullableString(value.imagePoolJson)
    && isNullableStringArray(value.imagePool)
  );
}

function cloneProjectRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    imagePool: Array.isArray(record.imagePool) ? [...record.imagePool] : record.imagePool,
  };
}

function toProjectSummary(record: ProjectRecord): ProjectSummaryRecord {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

function parsePersistedState(raw: string):
  | { ok: true; records: ProjectRecord[] }
  | { ok: false; reason: 'invalid-data' | 'unsupported-version' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-data' };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'invalid-data' };
  }
  if (parsed.version !== WEB_PROJECT_STATE_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!Array.isArray(parsed.projects) || !parsed.projects.every(isProjectRecord)) {
    return { ok: false, reason: 'invalid-data' };
  }

  return {
    ok: true,
    records: parsed.projects.map(cloneProjectRecord),
  };
}

function resolveDefaultStorage(): WebProjectStorage | null {
  return globalThis.localStorage ?? null;
}

export function createWebProjectStateAdapter(
  options: CreateWebProjectStateAdapterOptions = {}
): WebProjectStateAdapter {
  const storageKey = options.storageKey ?? WEB_PROJECT_STATE_STORAGE_KEY;
  const records = new Map<string, ProjectRecord>();
  let database: IDBDatabase | undefined;
  let loaded: Promise<void> | undefined;
  let mutations = Promise.resolve();
  let storageStatus: WebProjectStorageStatus = { mode: 'pending' };
  const fallBackToMemory = (reason: WebProjectStorageFallbackReason): void => {
    if (storageStatus.mode === 'memory') return;
    storageStatus = { mode: 'memory', reason };
    options.onStatusChange?.(storageStatus);
  };
  const writeRecord = async (id: string, record?: ProjectRecord): Promise<void> => {
    if (!database || storageStatus.mode !== 'persistent') return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database!.transaction('projects', 'readwrite');
        if (record) tx.objectStore('projects').put(record, id);
        else tx.objectStore('projects').delete(id);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Project transaction failed'));
      });
    } catch { fallBackToMemory('write-failed'); }
  };
  const ensureLoaded = (): Promise<void> => {
    if (!loaded) loaded = (async () => {
      let factory: IDBFactory | null | undefined;
      try { factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB; }
      catch { fallBackToMemory('unavailable'); return; }
      if (!factory) { fallBackToMemory('unavailable'); return; }
      try {
        database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = factory!.open(options.databaseName ?? 'storyboard-copilot:web-projects', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
            if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Project database blocked'));
        });
        database.onversionchange = () => { database?.close(); fallBackToMemory('unavailable'); };
        const snapshot = await new Promise<{ projects: unknown[]; migrated: boolean }>((resolve, reject) => {
          const tx = database!.transaction(['projects', 'metadata'], 'readonly');
          const projects = tx.objectStore('projects').getAll();
          const migrated = tx.objectStore('metadata').get(storageKey);
          tx.oncomplete = () => resolve({ projects: projects.result, migrated: migrated.result === true });
          tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Project database read failed'));
        });
        if (!snapshot.projects.every(isProjectRecord)) { fallBackToMemory('invalid-data'); return; }
        for (const record of snapshot.projects) records.set(record.id, cloneProjectRecord(record));
        if (!snapshot.migrated) {
          let raw: string | null = null;
          try {
            const configured = options.storage;
            const storage = typeof configured === 'function' ? configured() : configured === undefined ? resolveDefaultStorage() : configured;
            raw = storage?.getItem(storageKey) ?? null;
          } catch {
            // Existing IndexedDB records stay usable; never mark unreadable legacy data as migrated.
            if (!snapshot.projects.length) { fallBackToMemory('read-failed'); return; }
          }
          const parsed = raw === null ? { ok: true as const, records: [] } : parsePersistedState(raw);
          if (!parsed.ok) { fallBackToMemory(parsed.reason); return; }
          for (const record of parsed.records) if (!records.has(record.id)) records.set(record.id, cloneProjectRecord(record));
          await new Promise<void>((resolve, reject) => {
            const tx = database!.transaction(['projects', 'metadata'], 'readwrite');
            const store = tx.objectStore('projects');
            for (const record of parsed.records) if (!snapshot.projects.some((existing) => (existing as ProjectRecord).id === record.id)) store.put(record, record.id);
            tx.objectStore('metadata').put(true, storageKey);
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Project migration write failed'));
          });
        }
        // Preserve the exact legacy envelope in durable storage before releasing the
        // shared ~5 MiB localStorage quota used by settings and Agent accounting.
        // Also clean up envelopes retained by earlier IndexedDB migrations.
        try {
          const configured = options.storage;
          const storage = typeof configured === 'function' ? configured() : configured === undefined ? resolveDefaultStorage() : configured;
          const raw = storage?.getItem(storageKey);
          if (raw && storage?.removeItem && parsePersistedState(raw).ok) {
            await new Promise<void>((resolve, reject) => {
              const tx = database!.transaction('metadata', 'readwrite');
              tx.objectStore('metadata').put(raw, `legacy-backup:${storageKey}`);
              tx.oncomplete = () => resolve();
              tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Legacy backup failed'));
            });
            if (storage.getItem(storageKey) === raw) storage.removeItem(storageKey);
          }
        } catch {
          // Migration is committed; cleanup failure must never discard its result.
          // The original localStorage envelope remains available for a later load.
        }
        storageStatus = { mode: 'persistent' };
      } catch { fallBackToMemory(database ? 'write-failed' : 'unavailable'); }
    })();
    return loaded;
  };
  const mutate = (operation: () => Promise<void>): Promise<void> => {
    const pending = mutations.then(async () => { await ensureLoaded(); await operation(); });
    mutations = pending.catch(() => undefined);
    return pending;
  };
  return {
    async listProjectSummaries() {
      await ensureLoaded(); await mutations;
      return Array.from(records.values(), toProjectSummary).sort((left, right) => right.updatedAt - left.updatedAt);
    },
    async getProjectRecord(id) {
      await ensureLoaded(); await mutations;
      const record = records.get(id);
      return record ? cloneProjectRecord(record) : null;
    },
    upsertProjectRecord: (record) => mutate(async () => {
      const copy = cloneProjectRecord(record);
      records.set(copy.id, copy);
      await writeRecord(copy.id, copy);
    }),
    updateProjectViewportRecord: (id, viewportJson) => mutate(async () => {
      const record = records.get(id); if (!record) return;
      const next = { ...record, viewportJson }; records.set(id, next); await writeRecord(id, next);
    }),
    renameProjectRecord: (id, name, updatedAt) => mutate(async () => {
      const record = records.get(id); if (!record) return;
      const next = { ...record, name, updatedAt }; records.set(id, next); await writeRecord(id, next);
    }),
    deleteProjectRecord: (id) => mutate(async () => {
      if (!records.delete(id)) return;
      await writeRecord(id);
    }),
    getStorageStatus: () => storageStatus,
  };
}

type WebProjectStorageStatusListener = (status: WebProjectStorageStatus) => void;

const storageStatusListeners = new Set<WebProjectStorageStatusListener>();
const defaultWebProjectStateAdapter = createWebProjectStateAdapter({
  onStatusChange: (status) => {
    console.warn('[projectState] browser persistence unavailable; using session memory', {
      reason: status.mode === 'memory' ? status.reason : undefined,
    });
    storageStatusListeners.forEach((listener) => listener(status));
  },
});

export function subscribeWebProjectStorageStatus(
  listener: WebProjectStorageStatusListener
): () => void {
  storageStatusListeners.add(listener);
  const currentStatus = defaultWebProjectStateAdapter.getStorageStatus();
  if (currentStatus.mode === 'memory') {
    listener(currentStatus);
  }
  return () => {
    storageStatusListeners.delete(listener);
  };
}

export function listWebProjectSummaries(): Promise<ProjectSummaryRecord[]> {
  return defaultWebProjectStateAdapter.listProjectSummaries();
}

export function getWebProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  return defaultWebProjectStateAdapter.getProjectRecord(projectId);
}

export function upsertWebProjectRecord(record: ProjectRecord): Promise<void> {
  return defaultWebProjectStateAdapter.upsertProjectRecord(record);
}

export function updateWebProjectViewportRecord(
  projectId: string,
  viewportJson: string
): Promise<void> {
  return defaultWebProjectStateAdapter.updateProjectViewportRecord(projectId, viewportJson);
}

export function renameWebProjectRecord(
  projectId: string,
  name: string,
  updatedAt: number
): Promise<void> {
  return defaultWebProjectStateAdapter.renameProjectRecord(projectId, name, updatedAt);
}

export function deleteWebProjectRecord(projectId: string): Promise<void> {
  return defaultWebProjectStateAdapter.deleteProjectRecord(projectId);
}
