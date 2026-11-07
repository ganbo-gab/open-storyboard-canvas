import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createKnowledgeStore } from './knowledgeStore';
import { ensureKnowledgeService } from './ensureKnowledgeService';
import { KnowledgeError, type VaultEntry } from '../domain/types';
import { tauriKnowledgeIO } from '../infrastructure/tauriKnowledgeIO';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/commands/image', () => ({ loadImage: vi.fn() }));
vi.mock('@/features/assets/application/assetMediaStorage', () => ({ getAssetPortableSource: vi.fn() }));

const filesystemArguments = z.object({ root: z.string(), path: z.string().optional(), paths: z.array(z.string()).optional() });
let sandbox: string;

/** Filesystem-backed IPC fixture, not evidence of native no-follow implementation. */
async function requireExistingRoot(root: string): Promise<void> {
  for (let current = root; ; current = dirname(current)) {
    const metadata = await lstat(current).catch(() => { throw new KnowledgeError('INVALID_VAULT', 'Missing authorized directory'); });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new KnowledgeError('INVALID_VAULT', 'Replaced authorized directory');
    if (dirname(current) === current) return;
  }
}

async function filesystemInvoke(command: string, args: unknown): Promise<unknown> {
  const { root, path, paths } = filesystemArguments.parse(args);
  if (command === 'knowledge_init_vault') {
    await mkdir(root, { recursive: true });
    const canonical = await realpath(root);
    await mkdir(join(canonical, 'attachments'), { recursive: true });
    return canonical;
  }
  await requireExistingRoot(root);
  switch (command) {
    case 'knowledge_open_vault': return root;
    case 'knowledge_list_tree': {
      const entries: VaultEntry[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const metadata = await lstat(join(root, entry.name));
        entries.push({ path: entry.name, name: entry.name, kind: 'note', size: metadata.size, modifiedAt: Math.trunc(metadata.mtimeMs) });
      }
      return entries;
    }
    case 'knowledge_read_notes':
      return Promise.all(z.array(z.string()).parse(paths).map(async notePath => ({ path: notePath, content: await readFile(join(root, notePath), 'utf8') })));
    case 'knowledge_read_note': return readFile(join(root, z.string().parse(path)), 'utf8');
    default: throw new Error(`Unsupported filesystem fixture operation: ${command}`);
  }
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-reopen-')));
  mocks.invoke.mockReset().mockImplementation(filesystemInvoke);
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

async function selectedVault() {
  const authorized = join(sandbox, 'authorized');
  const outside = join(sandbox, 'outside');
  await mkdir(authorized);
  await mkdir(outside);
  await writeFile(join(authorized, 'Original.md'), '# Original authorization');
  await writeFile(join(outside, 'Outside.md'), '# Outside material');
  let savedRoot: string | null = null;
  const dependencies = {
    io: tauriKnowledgeIO,
    getVaultPath: () => savedRoot,
    setVaultPath: (path: string | null) => { savedRoot = path; },
    chooseVault: async () => authorized,
  };
  const selected = createKnowledgeStore(dependencies);
  await selected.getState().initialize(authorized);
  expect(selected.getState().tree.map(entry => entry.path)).toEqual(['Original.md']);
  expect(savedRoot).toBe(authorized);
  await rename(authorized, join(sandbox, 'original-tree'));
  return { authorized, outside, dependencies, savedRoot: () => savedRoot };
}

describe('saved vault authorization', () => {
  it.each(['startup', 'Agent'] as const)('rejects a swapped saved root during %s without exposing or authorizing the other tree', async entry => {
    const fixture = await selectedVault();
    await symlink(fixture.outside, fixture.authorized, process.platform === 'win32' ? 'junction' : 'dir');
    const reopened = createKnowledgeStore(fixture.dependencies);
    const opening = entry === 'startup' ? reopened.getState().initialize() : ensureKnowledgeService(reopened);
    await expect(opening).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    expect(reopened.getState()).toMatchObject({ status: 'error', vaultPath: fixture.authorized, tree: [], activeNote: null, searchResults: [] });
    expect(() => reopened.getState().getService()).toThrow(expect.objectContaining({ code: 'VAULT_UNSET' }));
    expect(fixture.savedRoot()).toBe(fixture.authorized);
    expect(await readdir(fixture.outside)).toEqual(['Outside.md']);
    expect(await readFile(join(fixture.outside, 'Outside.md'), 'utf8')).toBe('# Outside material');
  });

  it.each(['startup', 'Agent'] as const)('does not recreate a missing saved root during %s', async entry => {
    const fixture = await selectedVault();
    const reopened = createKnowledgeStore(fixture.dependencies);
    const opening = entry === 'startup' ? reopened.getState().initialize() : ensureKnowledgeService(reopened);
    await expect(opening).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    expect(reopened.getState()).toMatchObject({ status: 'error', vaultPath: fixture.authorized, tree: [] });
    expect(fixture.savedRoot()).toBe(fixture.authorized);
    await expect(lstat(fixture.authorized)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['path', 'chooser'] as const)('allows deliberate %s selection to authorize the substituted alias once', async selection => {
    const fixture = await selectedVault();
    await symlink(fixture.outside, fixture.authorized, process.platform === 'win32' ? 'junction' : 'dir');
    const store = createKnowledgeStore(fixture.dependencies);
    if (selection === 'path') await store.getState().initialize(fixture.authorized);
    else await store.getState().chooseVault();
    expect(fixture.savedRoot()).toBe(fixture.outside);
    expect(store.getState()).toMatchObject({ status: 'ready', vaultPath: fixture.outside });
    expect(store.getState().tree.map(entry => entry.path)).toEqual(['Outside.md']);
    expect((await store.getState().getService().read('Outside.md')).content).toBe('# Outside material');
    const reloaded = createKnowledgeStore(fixture.dependencies);
    const service = await ensureKnowledgeService(reloaded);
    expect(service.root).toBe(fixture.outside);
    expect(service.search('Outside').map(result => result.path)).toEqual(['Outside.md']);
    expect(fixture.savedRoot()).toBe(fixture.outside);
  });
});
