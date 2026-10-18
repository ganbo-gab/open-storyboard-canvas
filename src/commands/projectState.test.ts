import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord, WebProjectStorage } from './webProjectState';

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: tauriMocks.isTauri,
  invoke: tauriMocks.invoke,
}));

class FakeStorage implements WebProjectStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const record: ProjectRecord = {
  id: 'browser-project',
  name: 'Browser project',
  createdAt: 10,
  updatedAt: 20,
  nodeCount: 1,
  nodesJson: '[{"id":"node-1"}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[],"imagePool":[]}',
  imagePoolJson: '[]',
};

describe('project state runtime routing', () => {
  beforeEach(() => {
    vi.resetModules();
    tauriMocks.isTauri.mockReset();
    tauriMocks.invoke.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('uses browser persistence without invoking Tauri commands on Web', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new FakeStorage(),
    });
    tauriMocks.isTauri.mockReturnValue(false);
    const commands = await import('./projectState');

    await commands.upsertProjectRecord(record);
    await commands.renameProjectRecord(record.id, 'Renamed', 30);
    await commands.updateProjectViewportRecord(record.id, '{"x":5,"y":6,"zoom":1.1}');

    expect(await commands.listProjectSummaries()).toEqual([
      {
        id: record.id,
        name: 'Renamed',
        createdAt: record.createdAt,
        updatedAt: 30,
        nodeCount: record.nodeCount,
      },
    ]);
    expect(await commands.getProjectRecord(record.id)).toMatchObject({
      name: 'Renamed',
      viewportJson: '{"x":5,"y":6,"zoom":1.1}',
    });

    await commands.deleteProjectRecord(record.id);
    expect(await commands.getProjectRecord(record.id)).toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('preserves the native Tauri command path', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValueOnce([]);
    const commands = await import('./projectState');

    await expect(commands.listProjectSummaries()).resolves.toEqual([]);

    expect(tauriMocks.invoke).toHaveBeenCalledWith('list_project_summaries');
  });
});
