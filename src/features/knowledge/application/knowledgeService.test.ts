import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeVaultIO } from './ports';
import { KnowledgeService } from './knowledgeService';
import { createKnowledgeAgentTools } from './knowledgeAgentTools';
import { KnowledgeError, type VaultEntry } from '../domain/types';
import { buildOrganizeEdits, validateOrganizeResult } from '../domain/organize';
import { parseMarkdown } from '../domain/markdown';
import { createKnowledgeStore } from './knowledgeStore';
import { ensureKnowledgeService } from './ensureKnowledgeService';

class MemoryVault implements KnowledgeVaultIO {
  readonly files = new Map<string, { content: string | Uint8Array; time: number }>();
  readonly deleted = new Map<string, { content: string | Uint8Array; time: number }>();
  readBatches = 0;
  private clock = 0;
  async initVault(root: string) { return root; }
  async openVault(root: string) { return root; }
  async listTree(): Promise<VaultEntry[]> { return [...this.files].map(([path, value]) => ({ path, name: path.split('/').at(-1)!, kind: /\.md$/i.test(path) ? 'note' : 'attachment', modifiedAt: value.time, size: value.content.length })); }
  async readNote(_root: string, path: string) { const file = this.files.get(path); if (!file || typeof file.content !== 'string') throw new KnowledgeError('NOT_FOUND', path); return file.content; }
  async readNotes(root: string, paths: string[]) { this.readBatches++; return Promise.all(paths.map(async path => ({ path, content: await this.readNote(root, path) }))); }
  async writeNote(_root: string, path: string, content: string, createOnly: boolean) { if (createOnly && this.files.has(path)) throw new KnowledgeError('ALREADY_EXISTS', path); this.files.set(path, { content, time: ++this.clock }); }
  async writeAttachment(_root: string, path: string, content: Uint8Array, createOnly: boolean) { if (createOnly && this.files.has(path)) throw new KnowledgeError('ALREADY_EXISTS', path); this.files.set(path, { content, time: ++this.clock }); }
  async readAttachment(_root: string, path: string) { const file = this.files.get(path); if (!file || typeof file.content === 'string') throw new KnowledgeError('NOT_FOUND', path); return file.content.slice(); }
  async removeAttachment(root: string, path: string) { const file = this.files.get(path); if (!file || typeof file.content === 'string') throw new KnowledgeError('INVALID_ATTACHMENT', path); return this.trash(root, path); }
  async rename(_root: string, from: string, to: string) { if (this.files.has(to)) throw new KnowledgeError('ALREADY_EXISTS', to); const file = this.files.get(from); if (!file) throw new KnowledgeError('NOT_FOUND', from); this.files.set(to, file); this.files.delete(from); }
  async trash(_root: string, path: string) { const file = this.files.get(path); if (!file) throw new KnowledgeError('NOT_FOUND', path); this.deleted.set(path, file); this.files.delete(path); return path; }
  async listTrash(): Promise<VaultEntry[]> { return [...this.deleted].map(([path, value]) => ({ path, name: path, kind: 'note', modifiedAt: value.time, size: value.content.length })); }
  async restore(_root: string, path: string, destination: string) { if (this.files.has(destination)) throw new KnowledgeError('ALREADY_EXISTS', destination); const file = this.deleted.get(path); if (!file) throw new KnowledgeError('NOT_FOUND', path); this.files.set(destination, file); this.deleted.delete(path); }
}
const root = '/vault';
const now = () => new Date('2026-10-25T12:00:00.000Z');

describe('knowledge ingest and refresh', () => {
  it('resolves note/attachment collisions without replacing original bytes', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io, { now });
    await io.writeNote(root, 'Sample.md', 'original', true);
    await io.writeAttachment(root, 'attachments/image.png', new Uint8Array([1]), true);
    const text = await kb.ingest({ kind: 'text', title: 'Sample', text: 'new body  \n' });
    expect(text.notePath).toBe('Sample 2.md'); expect(await kb.read('Sample.md')).toEqual({ path: 'Sample.md', content: 'original' });
    expect(parseMarkdown((await kb.read(text.notePath)).content).body).toBe('new body  \n');
    const file = await kb.ingest({ kind: 'file', name: 'image.png', title: 'Sample', bytes: new Uint8Array([2, 3]) });
    expect(file).toEqual({ notePath: 'Sample 3.md', attachmentPaths: ['attachments/image 2.png'] });
    expect((await kb.read(file.notePath)).content).toContain('![[attachments/image 2.png]]');
    expect(io.files.get('attachments/image.png')?.content).toEqual(new Uint8Array([1]));
  });
  it('imports URLs without fetch and snapshots through an injected media reader', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io, { now, resolveMedia: async media => ({ name: media.name, bytes: new Uint8Array([9]) }) });
    const url = await kb.ingest({ kind: 'url', url: 'https://example.com/reference' });
    expect((await kb.read(url.notePath)).content).toContain('<https://example.com/reference>');
    await expect(kb.ingest({ kind: 'url', url: 'file:///etc/passwd' })).rejects.toThrow();
    const result = await kb.ingest({ kind: 'canvas', snapshot: { kind: 'image', title: 'Shot', prompt: 'A crane', params: { ratio: '16:9' }, media: [{ reference: 'asset-media:source', name: 'shot.png' }] } });
    const note = parseMarkdown((await kb.read(result.notePath)).content);
    expect(note.frontmatter.source).toBe('canvas'); expect(note.frontmatter.created).toBe(now().toISOString()); expect(note.body).toContain('![[attachments/shot.png]]'); expect(note.body).toContain('"ratio": "16:9"');
  });
  it('reindexes only changed notes and removes deleted notes on refresh', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await io.writeNote(root, 'A.md', '# First', true); await kb.refresh(); expect(io.readBatches).toBe(1);
    await kb.refresh(); expect(io.readBatches).toBe(1);
    await io.writeNote(root, 'A.md', '# Second', false); await kb.refresh(); expect(kb.search('Second')).toHaveLength(1); expect(kb.search('First')).toHaveLength(0);
    await kb.trash('A.md'); expect(kb.search('Second')).toEqual([]);
    await kb.restore('A.md'); expect(kb.search('Second')).toHaveLength(1);
  });
  it('rejects unsafe paths before touching IO', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await expect(kb.write('../escape.md', 'unsafe')).rejects.toThrow();
    await expect(kb.ingest({ kind: 'text', text: 'unsafe', folder: '../outside' })).rejects.toThrow();
    expect(io.files.size).toBe(0);
  });
  it('indexes a completed write even when an older refresh was already scanning', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await kb.write('Before.md', '# Before', true);
    const list = io.listTree.bind(io); const gate = Promise.withResolvers<void>(); const scanned = Promise.withResolvers<void>();
    vi.spyOn(io, 'listTree').mockImplementationOnce(async () => {
      const snapshot = await list(); scanned.resolve(); await gate.promise; return snapshot;
    });
    const oldScan = kb.refresh();
    await scanned.promise;
    const writing = kb.write('Added.md', '# Added', true);
    await Promise.resolve(); gate.resolve();
    await Promise.all([oldScan, writing]);
    expect(kb.search('Added').map(result => result.path)).toEqual(['Added.md']);
  });
});
describe('local attachment management', () => {
  it('round-trips binary bytes and nested metadata across a store reload without creating a note', async () => {
    const io = new MemoryVault(); let savedRoot: string | null = null;
    const deps = { io, getVaultPath: () => savedRoot, setVaultPath: (path: string | null) => { savedRoot = path; }, chooseVault: async () => root };
    const first = createKnowledgeStore(deps);
    await first.getState().initialize(root);
    const bytes = new Uint8Array([0, 255, 128, 10, 0, 13]);
    const imported = await first.getState().importAttachment({ name: '图.png', bytes, folder: '场景/day' });
    expect(imported).toMatchObject({ path: 'attachments/场景/day/图.png', size: 6, mediaType: 'image/png', kind: 'attachment' });
    expect(first.getState().activeNote).toBeNull();
    const reloaded = createKnowledgeStore(deps);
    await reloaded.getState().initialize();
    expect(savedRoot).toBe(root);
    expect(await reloaded.getState().listAttachments('场景')).toEqual([imported]);
    expect(await reloaded.getState().listAttachments('场景/daylight')).toEqual([]);
    expect((await reloaded.getState().readAttachment(imported.path)).bytes).toEqual(bytes);
    const receipt = await reloaded.getState().removeAttachment(imported.path);
    expect(await reloaded.getState().listAttachments()).toEqual([]);
    expect(reloaded.getState().trashEntries).toHaveLength(1);
    await reloaded.getState().restore(receipt, imported.path);
    expect((await reloaded.getState().readAttachment(imported.path)).bytes).toEqual(bytes);
  });
  it('avoids duplicates and concurrent destination conflicts without replacing source bytes', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    const first = await kb.importAttachment({ name: 'sample.bin', bytes: new Uint8Array([1]) });
    const [second, third] = await Promise.all([
      kb.importAttachment({ name: 'sample.bin', bytes: new Uint8Array([2]) }),
      kb.importAttachment({ name: 'sample.bin', bytes: new Uint8Array([3]) }),
    ]);
    expect([first.path, second.path, third.path].sort()).toEqual(['attachments/sample 2.bin', 'attachments/sample 3.bin', 'attachments/sample.bin']);
    expect((await kb.readAttachment(first.path)).bytes).toEqual(new Uint8Array([1]));
    expect((await kb.readAttachment(second.path)).bytes).toEqual(new Uint8Array([2]));
    expect((await kb.readAttachment(third.path)).bytes).toEqual(new Uint8Array([3]));
    expect(first.mediaType).toBe('application/octet-stream');
  });
  it.each(['../outside.bin', '/tmp/outside.bin', 'C:\\\\outside.bin', '%2e%2e.bin', '%252e%252e.bin', '.knowledge-pending.bin'])('rejects unsafe imports before IO: %s', async name => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await expect(kb.importAttachment({ name, bytes: new Uint8Array([7]) })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(io.files.size).toBe(0);
  });
  it('rejects note/directory/out-of-scope attachment operations and preserves the files', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await io.writeNote(root, 'Note.md', '# Original', true);
    for (const path of ['Note.md', 'attachments', 'attachments/../Note.md', 'attachments/%2e%2e/Note.md']) {
      await expect(kb.readAttachment(path)).rejects.toThrow();
      await expect(kb.removeAttachment(path)).rejects.toThrow();
    }
    expect(await kb.read('Note.md')).toMatchObject({ content: '# Original' });
    await expect(kb.importAttachment({ name: 'note.MD', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    await expect(kb.importAttachment({ name: 'ok.bin', folder: '../outside', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    const empty = await kb.importAttachment({ name: 'empty.bin', bytes: new Uint8Array() });
    expect((await kb.readAttachment(empty.path)).bytes).toEqual(new Uint8Array());
  });
  it('persists the canonical explicit root only after indexing succeeds and reopens without a chooser', async () => {
    const io = new MemoryVault(); let savedRoot: string | null = null;
    const chooser = vi.fn(async () => '/selected/../vault');
    const init = vi.spyOn(io, 'initVault').mockResolvedValue(root);
    const deps = { io, chooseVault: chooser, getVaultPath: () => savedRoot, setVaultPath: (path: string | null) => { savedRoot = path; } };
    const store = createKnowledgeStore(deps);
    await store.getState().chooseVault();
    expect(savedRoot).toBe(root);
    const reloaded = createKnowledgeStore(deps);
    await ensureKnowledgeService(reloaded);
    expect(reloaded.getState().vaultPath).toBe(root);
    expect(chooser).toHaveBeenCalledTimes(1);
    await expect(store.getState().initialize('relative/vault')).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    expect(store.getState().vaultPath).toBe(root);
    init.mockRejectedValueOnce(new KnowledgeError('PERMISSION_DENIED', 'blocked'));
    await expect(store.getState().initialize('/blocked')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(savedRoot).toBe(root);
  });
  it('does not persist a superseded initialization', async () => {
    const io = new MemoryVault(); const gate = Promise.withResolvers<string>();
    vi.spyOn(io, 'initVault').mockImplementation(path => path === '/old' ? gate.promise : Promise.resolve(path));
    let savedRoot: string | null = null;
    const store = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => savedRoot, setVaultPath: path => { savedRoot = path; } });
    const old = store.getState().initialize('/old');
    await store.getState().initialize('/new');
    gate.resolve('/old'); await old;
    expect(store.getState().vaultPath).toBe('/new'); expect(savedRoot).toBe('/new');
  });
  it.each(['resolve', 'reject'] as const)('ignores a superseded saved-root reopen that later %ss', async outcome => {
    const io = new MemoryVault(); const gate = Promise.withResolvers<string>();
    vi.spyOn(io, 'openVault').mockImplementationOnce(() => gate.promise);
    let savedRoot: string | null = root;
    const store = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => savedRoot, setVaultPath: path => { savedRoot = path; } });
    const reopening = store.getState().initialize();
    expect(store.getState().status).toBe('loading');
    await store.getState().initialize('/new');
    if (outcome === 'resolve') gate.resolve(root);
    else gate.reject(new KnowledgeError('INVALID_VAULT', 'Replaced old root'));
    await reopening;
    expect(store.getState()).toMatchObject({ status: 'ready', vaultPath: '/new', error: null });
    expect(store.getState().getService().root).toBe('/new');
    expect(savedRoot).toBe('/new');
  });
  it('keeps an explicit unset durable when a saved-root reopen completes late', async () => {
    const io = new MemoryVault(); const gate = Promise.withResolvers<string>();
    vi.spyOn(io, 'openVault').mockImplementationOnce(() => gate.promise);
    let savedRoot: string | null = root;
    const deps = { io, chooseVault: async () => null, getVaultPath: () => savedRoot, setVaultPath: (path: string | null) => { savedRoot = path; } };
    const store = createKnowledgeStore(deps);
    const reopening = store.getState().initialize();
    await store.getState().initialize(null);
    gate.resolve(root); await reopening;
    expect(savedRoot).toBeNull();
    expect(store.getState()).toMatchObject({ status: 'unset', vaultPath: null, tree: [], error: null });
    await expect(ensureKnowledgeService(createKnowledgeStore(deps))).rejects.toMatchObject({ code: 'VAULT_UNSET' });
  });
  it('clears explicit root persistence when the vault is unset', async () => {
    const io = new MemoryVault(); let savedRoot: string | null = root;
    const store = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => savedRoot, setVaultPath: path => { savedRoot = path; } });
    await store.getState().initialize();
    await store.getState().initialize(null);
    expect(savedRoot).toBeNull();
    const reloaded = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => savedRoot, setVaultPath: path => { savedRoot = path; } });
    await reloaded.getState().initialize();
    expect(reloaded.getState().status).toBe('unset');
  });
  it('does not open a late ingestion result in a newly selected vault', async () => {
    const io = new MemoryVault(); const gate = Promise.withResolvers<void>();
    const store = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => root, setVaultPath: () => {} });
    await store.getState().initialize();
    const service = store.getState().getService();
    vi.spyOn(service, 'ingest').mockImplementation(async () => { await gate.promise; return { notePath: 'Old.md', attachmentPaths: [] }; });
    const opening = vi.spyOn(store.getState(), 'openNote');
    const pending = store.getState().ingest({ kind: 'text', text: 'Old note' });
    await store.getState().initialize('/new');
    gate.resolve(); await pending;
    expect(opening).not.toHaveBeenCalled();
    expect(store.getState().vaultPath).toBe('/new'); expect(store.getState().error).toBeNull();
  });
  it('does not publish a late old-vault failure into the newly selected vault', async () => {
    const io = new MemoryVault(); const gate = Promise.withResolvers<never>();
    const store = createKnowledgeStore({ io, chooseVault: async () => null, getVaultPath: () => root, setVaultPath: () => {} });
    await store.getState().initialize();
    vi.spyOn(store.getState().getService(), 'read').mockImplementation(() => gate.promise);
    const pending = store.getState().openNote('Old.md');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.getState().initialize('/new');
    gate.reject(new KnowledgeError('NOT_FOUND', 'Old.md')); await rejected;
    expect(store.getState().error).toBeNull(); expect(store.getState().status).toBe('ready');
  });
});
describe('AI organization contract', () => {
  it.each(['not json', '```json\n{}\n```', '{"kind":"tag","notes":[{"path":"../a.md","tags":["x"]}]}', '{"kind":"tag","notes":[{"path":"A.md","tags":[42]}]}', '{"kind":"summary","notes":[]}', '{"kind":"summary","notes":[{"path":"A.md","summary":"ok","extra":true}]}'])('rejects malformed output %s', raw => expect(() => validateOrganizeResult(raw)).toThrow());
  it('rejects wrong kinds and edits referencing unselected notes before applying', () => {
    expect(() => validateOrganizeResult('{"kind":"tag","notes":[{"path":"A.md","tags":[]}]}', 'summary')).toThrow();
    expect(() => buildOrganizeEdits({ kind: 'tag', notes: [{ path: 'Other.md', tags: ['x'] }] }, [{ path: 'A.md', content: 'body' }])).toThrow();
  });
  it('applies injected tagging, summaries, MOC and classification with preserved metadata', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await kb.write('A.md', '---\ncustom: preserved\ntags: [original]\n---\n# Body\nDetails', true);
    await kb.organize('tag', ['A.md'], async () => JSON.stringify({ kind: 'tag', notes: [{ path: 'A.md', tags: ['film'] }] }));
    const tagged = parseMarkdown((await kb.read('A.md')).content);
    expect(tagged.frontmatter).toEqual({ custom: 'preserved', tags: ['original', 'film'] });
    await kb.organize('summary', ['A.md'], async () => JSON.stringify({ kind: 'summary', notes: [{ path: 'A.md', summary: 'A useful summary' }] }));
    const summarized = parseMarkdown((await kb.read('A.md')).content); expect(summarized.body).toContain('> [!summary]\n> A useful summary\n\n# Body\nDetails');
    await kb.organize('moc', ['A.md'], async () => JSON.stringify({ kind: 'moc', title: 'Index', sections: [{ heading: 'Scenes', paths: ['A.md'] }] }));
    expect((await kb.read('Index.md')).content).toContain('[[A]]');
    await kb.organize('classify', ['A.md'], async () => JSON.stringify({ kind: 'classify', classifications: [{ path: 'A.md', folder: 'Scenes', tags: ['scene'] }] }));
    expect(parseMarkdown((await kb.read('Scenes/A.md')).content).frontmatter.tags).toEqual(['original', 'film', 'scene']);
  });
  it('bounds note count and total text before the provided model can run', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    const model = vi.fn(async () => '{"kind":"tag","notes":[{"path":"A.md","tags":["film"]}]}');
    await kb.write('A.md', 'A note. '.repeat(15_001));
    await expect(kb.organize('tag', ['A.md'], model)).rejects.toMatchObject({ code: 'INVALID_ORGANIZE_RESULT' });
    await expect(kb.organize('tag', Array.from({ length: 21 }, (_, i) => `${i}.md`), model)).rejects.toMatchObject({ code: 'INVALID_ORGANIZE_RESULT' });
    expect(model).not.toHaveBeenCalled();
    expect((await kb.read('A.md')).content).not.toContain('tags:');
  });
});
describe('knowledge agent tools', () => {
  it('enforces schemas on handler calls, not only model-supplied JSON schemas', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io); const tools = createKnowledgeAgentTools(kb);
    const write = tools.find(tool => tool.name === 'kb_write')!;
    for (const input of [{ path: '../A.md', content: 'bad' }, { path: 'A.md', content: 7 }, { path: 'A.md', content: 'bad', root: '/outside' }]) await expect(write.handler(input)).rejects.toThrow();
    expect(io.files.size).toBe(0);
    await write.handler({ path: 'A.md', content: '# Film', createOnly: true });
    await expect(write.handler({ path: 'A.md', content: 'overwrite', createOnly: true })).rejects.toThrow();
    const read = tools.find(tool => tool.name === 'kb_read')!;
    await expect(read.handler({ path: 'A.md' })).resolves.toMatchObject({ path: 'A.md', content: '# Film', offset: 0, totalCharacters: 6, nextOffset: null });
    await expect(tools.find(tool => tool.name === 'kb_search')!.handler({ text: 'Film', limit: 0 })).rejects.toThrow();
    await expect(tools.find(tool => tool.name === 'kb_search')!.handler({ text: 'Film' })).resolves.toEqual([expect.objectContaining({ path: 'A.md' })]);
    await expect(tools.find(tool => tool.name === 'kb_organize')!.handler({ kind: 'delete', paths: ['A.md'] })).rejects.toThrow();
    expect(write.mutates).toBe(true); expect(read.mutates).toBe(false);
  });
  it('returns bounded continuation pages past the audit long-value threshold', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    const content = '# A long note\n' + 'A scene with a moving camera. '.repeat(400);
    await kb.write('Long.md', content);
    const read = createKnowledgeAgentTools(kb).find((tool) => tool.name === 'kb_read')!;
    await expect(read.handler({ path: 'Long.md' })).resolves.toEqual({ path: 'Long.md', content: content.slice(0, 4000), offset: 0, totalCharacters: content.length, nextOffset: 4000 });
    await expect(read.handler({ path: 'Long.md', offset: 6000, limit: 2000 })).resolves.toEqual({ path: 'Long.md', content: content.slice(6000, 8000), offset: 6000, totalCharacters: content.length, nextOffset: 8000 });
    await expect(read.handler({ path: 'Long.md', offset: content.length + 20 })).resolves.toMatchObject({ content: '', offset: content.length, nextOffset: null });
    await expect(read.handler({ path: 'Long.md', limit: 5001 })).rejects.toThrow();
  });
});

describe('knowledge safety and UI state', () => {
  it('lazily initializes concurrent Agent calls once without opening a vault picker', async () => {
    const io = new MemoryVault();
    const chooseVault = vi.fn(async () => root);
    await io.writeNote(root, 'Saved.md', '# Persisted reference', true);
    const store = createKnowledgeStore({ io, getVaultPath: () => root, setVaultPath: () => {}, chooseVault });
    const [first, second] = await Promise.all([ensureKnowledgeService(store), ensureKnowledgeService(store)]);
    expect(first).toBe(second);
    expect(first.search('Persisted').map(result => result.path)).toEqual(['Saved.md']);
    expect(io.readBatches).toBe(1);
    expect(chooseVault).not.toHaveBeenCalled();
    expect(await ensureKnowledgeService(store)).toBe(first);
    expect(io.readBatches).toBe(1);
  });
  it('returns the typed unset-vault error without a picker or filesystem calls', async () => {
    const io = new MemoryVault();
    const chooseVault = vi.fn(async () => root);
    const unavailable = new KnowledgeError('IO_ERROR', 'Filesystem unavailable');
    vi.spyOn(io, 'initVault').mockRejectedValue(unavailable);
    vi.spyOn(io, 'openVault').mockRejectedValue(unavailable);
    const store = createKnowledgeStore({ io, getVaultPath: () => null, setVaultPath: () => {}, chooseVault });
    await expect(ensureKnowledgeService(store)).rejects.toMatchObject({ code: 'VAULT_UNSET' });
    expect(chooseVault).not.toHaveBeenCalled();
  });
  it('refuses stale AI writes when a note changes during the model call', async () => {
    const io = new MemoryVault(); const kb = new KnowledgeService(root, io);
    await kb.write('A.md', 'before', true);
    await expect(kb.organize('tag', ['A.md'], async () => {
      await io.writeNote(root, 'A.md', 'external edit', false);
      return JSON.stringify({ kind: 'tag', notes: [{ path: 'A.md', tags: ['film'] }] });
    })).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    expect((await kb.read('A.md')).content).toBe('external edit');
  });
  it('exposes selection, search, progress, errors, trash and restore without a proprietary note store', async () => {
    const io = new MemoryVault(); let savedRoot: string | null = root;
    const store = createKnowledgeStore({ io, getVaultPath: () => savedRoot, setVaultPath: path => { savedRoot = path; }, chooseVault: async () => root, serviceOptions: { now } });
    await store.getState().initialize();
    expect(store.getState().status).toBe('ready');
    const result = await store.getState().ingest({ kind: 'text', title: 'Shot', text: '# Scene\n#film' });
    expect(store.getState().activeNote?.path).toBe(result.notePath);
    expect(store.getState().ingestProgress).toMatchObject({ stage: 'done', completed: 1, total: 1 });
    store.getState().setSearchQuery('#film');
    expect(store.getState().searchResults).toHaveLength(1);
    await store.getState().saveNote('# Edited\n#film');
    expect(store.getState().activeNote?.content).toBe('# Edited\n#film');
    const trashed = await store.getState().trash(result.notePath);
    expect(store.getState().activeNote).toBeNull(); expect(store.getState().trashEntries).toHaveLength(1);
    await store.getState().restore(trashed);
    expect(store.getState().tree.some(entry => entry.path === result.notePath)).toBe(true);
    await expect(store.getState().openNote('Missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.getState().error?.code).toBe('NOT_FOUND'); store.getState().clearError(); expect(store.getState().error).toBeNull();
  });
  it('polls mtime changes into active notes and stops cleanly on cleanup', async () => {
    vi.useFakeTimers();
    try {
      const io = new MemoryVault();
      await io.writeNote(root, 'A.md', '# Before', true);
      const store = createKnowledgeStore({ io, getVaultPath: () => root, setVaultPath: () => {}, chooseVault: async () => root });
      await store.getState().initialize(); await store.getState().openNote('A.md');
      const stop = store.getState().startPolling(500);
      await io.writeNote(root, 'A.md', '# After', false);
      await vi.advanceTimersByTimeAsync(500);
      expect(store.getState().activeNote?.content).toBe('# After');
      stop();
      await io.writeNote(root, 'A.md', '# Ignored', false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.getState().activeNote?.content).toBe('# After');
    } finally { vi.useRealTimers(); }
  });
});
