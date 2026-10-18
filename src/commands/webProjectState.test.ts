import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_PROJECT_STATE_STORAGE_KEY, createWebProjectStateAdapter } from './webProjectState';
import type { ProjectRecord, WebProjectStorage } from './webProjectState';

class FakeStorage implements WebProjectStorage {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('Full origin', 'QuotaExceededError');
    this.values.set(key, value);
  }
}
function createRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id: 'project-1', name: 'Web project', createdAt: 100, updatedAt: 200, nodeCount: 1,
    nodesJson: '[{"id":"node-1"}]', edgesJson: '[]', viewportJson: '{"x":12,"y":24,"zoom":1.2}',
    historyJson: '{"past":[],"future":[],"imagePool":[]}', imagePoolJson: '[]', ...overrides };
}
afterEach(() => vi.restoreAllMocks());
describe('IndexedDB web project state adapter', () => {
  it('persists individual projects and restores the full canvas DTO after reload', async () => {
    const indexedDB = new IDBFactory(); const storage = new FakeStorage();
    const options = { indexedDB, storage };
    const record = createRecord();
    await createWebProjectStateAdapter(options).upsertProjectRecord(record);
    expect(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY)).toBeNull();
    const restored = createWebProjectStateAdapter(options);
    expect(await restored.getProjectRecord(record.id)).toEqual(record);
    expect(await restored.listProjectSummaries()).toEqual([{ id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt, nodeCount: 1 }]);
  });
  it('frees full localStorage only after durably archiving the complete legacy project', async () => {
    const indexedDB = new IDBFactory(); const storage = new FakeStorage();
    const original = createRecord({ imagePoolJson: JSON.stringify(['data:image/png;base64,' + 'A'.repeat(5_200_000)]) });
    const legacy = JSON.stringify({ version: 1, projects: [original] });
    storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, legacy); storage.failWrites = true;
    const options = { indexedDB, storage };
    const adapter = createWebProjectStateAdapter(options);
    expect(await adapter.getProjectRecord(original.id)).toEqual(original);
    expect(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY)).toBeNull();
    const database = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('storyboard-copilot:web-projects'); request.onsuccess = () => resolve(request.result); });
    const backup = await new Promise<unknown>((resolve) => { const request = database.transaction('metadata').objectStore('metadata').get(`legacy-backup:${WEB_PROJECT_STATE_STORAGE_KEY}`); request.onsuccess = () => resolve(request.result); });
    expect(backup).toBe(legacy);
    const updated = createRecord({ ...original, updatedAt: 300, imagePoolJson: JSON.stringify(['data:image/png;base64,' + 'B'.repeat(5_300_000)]) });
    await adapter.upsertProjectRecord(updated);
    expect(adapter.getStorageStatus()).toEqual({ mode: 'persistent' });
    expect(await createWebProjectStateAdapter(options).getProjectRecord(original.id)).toEqual(updated);
    database.close();
  });
  it('archives a retained old envelope on restart without resurrecting deleted projects', async () => {
    const indexedDB = new IDBFactory(); const storage = new FakeStorage();
    const record = createRecord(); const legacy = JSON.stringify({ version: 1, projects: [record] });
    storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, legacy);
    const adapter = createWebProjectStateAdapter({ indexedDB, storage });
    await adapter.deleteProjectRecord(record.id);
    storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, legacy);
    const restored = createWebProjectStateAdapter({ indexedDB, storage });
    expect(await restored.getProjectRecord(record.id)).toBeNull();
    expect(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY)).toBeNull();
  });
  it('preserves the legacy envelope if its archive cannot commit', async () => {
    const indexedDB = new IDBFactory(); const storage = new FakeStorage();
    const record = createRecord(); const legacy = JSON.stringify({ version: 1, projects: [record] });
    await createWebProjectStateAdapter({ indexedDB, storage }).upsertProjectRecord(record);
    storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, legacy);
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      if (args[0] === 'metadata' && args[1] === 'readwrite') throw new DOMException('Archive quota exhausted', 'QuotaExceededError');
      return transaction.apply(this, args);
    });
    const restored = createWebProjectStateAdapter({ indexedDB, storage });
    expect(await restored.getProjectRecord(record.id)).toEqual(record);
    expect(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY)).toBe(legacy);
    expect(restored.getStorageStatus()).toEqual({ mode: 'persistent' });
  });
  it('serializes CRUD and does not resurrect deleted records from the legacy envelope', async () => {
    const indexedDB = new IDBFactory(); const storage = new FakeStorage();
    const record = createRecord(); storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, JSON.stringify({ version: 1, projects: [record] }));
    const options = { indexedDB, storage }; const adapter = createWebProjectStateAdapter(options);
    await adapter.listProjectSummaries();
    await Promise.all([adapter.renameProjectRecord(record.id, 'Renamed', 300), adapter.updateProjectViewportRecord(record.id, '{"x":1,"y":2,"zoom":0.8}')]);
    expect(await createWebProjectStateAdapter(options).getProjectRecord(record.id)).toMatchObject({ name: 'Renamed', viewportJson: '{"x":1,"y":2,"zoom":0.8}', updatedAt: 300 });
    await adapter.deleteProjectRecord(record.id);
    expect(await createWebProjectStateAdapter(options).getProjectRecord(record.id)).toBeNull();
  });
  it('uses IndexedDB when localStorage is unavailable', async () => {
    const adapter = createWebProjectStateAdapter({ indexedDB: new IDBFactory(), storage: null });
    await adapter.upsertProjectRecord(createRecord());
    expect(adapter.getStorageStatus()).toEqual({ mode: 'persistent' });
  });
  it('retains session state and emits one warning if IndexedDB is unavailable', async () => {
    const onStatusChange = vi.fn();
    const adapter = createWebProjectStateAdapter({ indexedDB: null, onStatusChange });
    await adapter.upsertProjectRecord(createRecord());
    await adapter.renameProjectRecord('project-1', 'Session name', 300);
    expect(await adapter.getProjectRecord('project-1')).toMatchObject({ name: 'Session name' });
    expect(adapter.getStorageStatus()).toEqual({ mode: 'memory', reason: 'unavailable' });
    expect(onStatusChange).toHaveBeenCalledOnce();
  });
  it('preserves latest session state after a genuine database write failure', async () => {
    const onStatusChange = vi.fn();
    const adapter = createWebProjectStateAdapter({ indexedDB: new IDBFactory(), storage: null, onStatusChange });
    await adapter.listProjectSummaries();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('Disk quota exhausted', 'QuotaExceededError'); });
    await adapter.upsertProjectRecord(createRecord());
    expect(await adapter.getProjectRecord('project-1')).toEqual(createRecord());
    expect(adapter.getStorageStatus()).toEqual({ mode: 'memory', reason: 'write-failed' });
    expect(onStatusChange).toHaveBeenCalledOnce();
  });
  it.each(['{broken', JSON.stringify({ version: 99, projects: [] })])('preserves invalid/future legacy bytes without silently replacing them', async (legacy) => {
    const storage = new FakeStorage(); storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, legacy);
    const adapter = createWebProjectStateAdapter({ indexedDB: new IDBFactory(), storage });
    expect(await adapter.listProjectSummaries()).toEqual([]);
    await adapter.upsertProjectRecord(createRecord());
    expect(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY)).toBe(legacy);
    expect(adapter.getStorageStatus().mode).toBe('memory');
  });
});
