import { KnowledgeSearchIndex } from '../domain/search';
import { buildOrganizeEdits, buildOrganizePrompt, validateOrganizeResult, type KnowledgeModelPort, type OrganizeKind, type OrganizeResult } from '../domain/organize';
import { parseMarkdown, updateFrontmatter } from '../domain/markdown';
import { asKnowledgeError, assertNotePath, assertVaultRelativePath, KnowledgeError, type IngestProgress, type KnowledgeIngestInput, type KnowledgeIngestResult, type KnowledgeSearchQuery, type VaultEntry, type VaultNote } from '../domain/types';
import { assertAttachmentBytes, assertAttachmentPath, attachmentMetadata, type KnowledgeAttachment, type KnowledgeAttachmentContent, type KnowledgeAttachmentImport } from '../domain/attachments';
import type { KnowledgeMediaResolver, KnowledgeVaultIO } from './ports';

export const MAX_ORGANIZE_NOTES = 20;
export const MAX_ORGANIZE_CHARACTERS = 120_000;

export function safeKnowledgeName(input: string): string {
  const name = input.replace(/[\\/:*?"<>|#\[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').trim().slice(0, 180);
  return name || 'Untitled';
}
export function collisionSafePath(desired: string, occupied: ReadonlySet<string>): string {
  assertVaultRelativePath(desired);
  if (!occupied.has(desired.toLocaleLowerCase())) return desired;
  const slash = desired.lastIndexOf('/');
  const dot = desired.lastIndexOf('.');
  const split = dot > slash ? dot : desired.length;
  for (let index = 2; ; index++) {
    const candidate = `${desired.slice(0, split)} ${index}${desired.slice(split)}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
export interface KnowledgeServiceOptions { now?: () => Date; model?: KnowledgeModelPort; resolveMedia?: KnowledgeMediaResolver }
export class KnowledgeService {
  readonly index = new KnowledgeSearchIndex();
  private entries: VaultEntry[] = [];
  private readonly contents = new Map<string, string>();
  private refreshing: Promise<VaultEntry[]> | undefined;
  private rescanRequested = false;
  private forceRequested = false;
  constructor(readonly root: string, private readonly io: KnowledgeVaultIO, private readonly options: KnowledgeServiceOptions = {}) {}
  refresh(force = false): Promise<VaultEntry[]> {
    if (force) { this.forceRequested = true; this.rescanRequested = true; }
    if (!this.refreshing) this.refreshing = this.drainRefresh();
    return this.refreshing;
  }
  private refreshAfterMutation(): Promise<VaultEntry[]> {
    this.rescanRequested = true;
    return this.refresh();
  }
  private async drainRefresh(): Promise<VaultEntry[]> {
    try {
      let entries: VaultEntry[];
      do {
        const force = this.forceRequested;
        this.forceRequested = false;
        this.rescanRequested = false;
        entries = await this.refreshIndex(force);
      } while (this.rescanRequested);
      return entries;
    } finally {
      // Clear before settling the shared promise: a new mutation must never
      // attach to a completed scan in the promise-finally microtask gap.
      this.refreshing = undefined;
    }
  }
  private async refreshIndex(force: boolean): Promise<VaultEntry[]> {
    const entries = await this.io.listTree(this.root);
    const previous = new Map(this.entries.map(entry => [entry.path, entry]));
    const changed = entries.filter(entry => entry.kind === 'note' && (force || !this.contents.has(entry.path) || previous.get(entry.path)?.modifiedAt !== entry.modifiedAt || previous.get(entry.path)?.size !== entry.size));
    const notes = changed.length ? await this.io.readNotes(this.root, changed.map(entry => entry.path)) : [];
    // Parse all changes before committing the new index, so malformed YAML is surfaced, not silently ignored.
    for (const note of notes) parseMarkdown(note.content);
    const current = new Set(entries.filter(entry => entry.kind === 'note').map(entry => entry.path));
    for (const path of this.contents.keys()) if (!current.has(path)) { this.contents.delete(path); this.index.remove(path); }
    for (const note of notes) { this.index.upsert(note); this.contents.set(note.path, note.content); }
    this.entries = entries;
    return entries;
  }
  search(query: KnowledgeSearchQuery | string) { return this.index.search(query); }
  backlinks(path: string) { return this.index.backlinks(assertNotePath(path)); }
  tags(): string[] { return this.index.tags(); }
  async read(path: string): Promise<VaultNote> { return { path: assertNotePath(path), content: await this.io.readNote(this.root, path) }; }
  async write(path: string, content: string, createOnly = false): Promise<void> {
    assertNotePath(path); parseMarkdown(content);
    await this.io.writeNote(this.root, path, content, createOnly);
    await this.refresh(true);
  }
  async rename(from: string, to: string): Promise<void> {
    assertVaultRelativePath(from); assertVaultRelativePath(to);
    await this.io.rename(this.root, from, to); await this.refresh(true);
  }
  async trash(path: string): Promise<string> {
    assertVaultRelativePath(path);
    const trashPath = await this.io.trash(this.root, path); await this.refreshAfterMutation(); return trashPath;
  }
  /** Attachments stay local: no binary payload is exposed by the Agent tool contract. */
  async listAttachments(folder = ''): Promise<KnowledgeAttachment[]> {
    const prefix = folder ? assertAttachmentPath(`attachments/${folder}/_`).slice(0, -1) : 'attachments/';
    return (await this.io.listTree(this.root))
      .filter(entry => entry.kind === 'attachment' && entry.path.startsWith(prefix))
      .map(attachmentMetadata);
  }
  private async createAttachment(input: KnowledgeAttachmentImport): Promise<string> {
    assertVaultRelativePath(input.name);
    if (input.name.includes('/')) throw new KnowledgeError('INVALID_ATTACHMENT', 'Attachment name must be a filename; use folder for nested paths');
    const folder = input.folder ? `${input.folder}/` : '';
    const desired = assertAttachmentPath(`attachments/${folder}${input.name}`);
    assertAttachmentBytes(input.bytes);
    return this.createUnique(desired, path => this.io.writeAttachment(this.root, path, input.bytes, true));
  }
  async importAttachment(input: KnowledgeAttachmentImport): Promise<KnowledgeAttachment> {
    const path = await this.createAttachment(input);
    await this.refreshAfterMutation();
    return this.requireAttachment(path);
  }
  private async requireAttachment(path: string): Promise<KnowledgeAttachment> {
    assertAttachmentPath(path);
    const entry = (await this.io.listTree(this.root)).find(entry => entry.path === path);
    if (!entry) throw new KnowledgeError('NOT_FOUND', path);
    return attachmentMetadata(entry);
  }
  async readAttachment(path: string): Promise<KnowledgeAttachmentContent> {
    const attachment = await this.requireAttachment(path);
    const bytes = await this.io.readAttachment(this.root, path);
    assertAttachmentBytes(bytes);
    return { attachment: { ...attachment, size: bytes.byteLength }, bytes };
  }
  async removeAttachment(path: string): Promise<string> {
    assertAttachmentPath(path);
    const trashPath = await this.io.removeAttachment(this.root, path);
    await this.refreshAfterMutation();
    return trashPath;
  }
  listTrash(): Promise<VaultEntry[]> { return this.io.listTrash(this.root); }
  async restore(trashPath: string, destination = trashPath): Promise<void> {
    assertVaultRelativePath(trashPath); assertVaultRelativePath(destination);
    await this.io.restore(this.root, trashPath, destination); await this.refreshAfterMutation();
  }
  private async createUnique(desired: string, write: (path: string) => Promise<void>): Promise<string> {
    const occupied = new Set((await this.io.listTree(this.root)).map(entry => entry.path.toLocaleLowerCase()));
    for (;;) {
      const path = collisionSafePath(desired, occupied);
      try { await write(path); return path; }
      catch (error) { if (asKnowledgeError(error).code !== 'ALREADY_EXISTS') throw error; occupied.add(path.toLocaleLowerCase()); }
    }
  }
  async createNote(title: string, content: string, folder = ''): Promise<string> {
    if (folder) assertVaultRelativePath(folder);
    parseMarkdown(content);
    const desired = `${folder ? `${folder}/` : ''}${safeKnowledgeName(title).replace(/\.md$/i, '')}.md`;
    const path = await this.createUnique(desired, path => this.io.writeNote(this.root, path, content, true));
    await this.refreshAfterMutation(); return path;
  }
  async ingest(input: KnowledgeIngestInput, onProgress?: (progress: IngestProgress) => void): Promise<KnowledgeIngestResult> {
    if (input.folder) assertVaultRelativePath(input.folder);
    const attachmentPaths: string[] = [];
    const mediaCount = input.kind === 'file' ? (/\.md$/i.test(input.name) ? 0 : 1) : input.kind === 'canvas' ? input.snapshot.media.length : 0;
    const total = mediaCount + 1;
    const progress = (stage: IngestProgress['stage']): void => onProgress?.({ stage, completed: stage === 'done' ? total : attachmentPaths.length, total });
    const attach = async (name: string, bytes: Uint8Array): Promise<string> => {
      progress('attachment');
      const path = await this.createAttachment({ name: safeKnowledgeName(name), bytes });
      attachmentPaths.push(path); return path;
    };
    let title: string;
    let body: string;
    let source: string;
    if (input.kind === 'text') {
      title = input.title ?? input.text.trim().split(/\r?\n/)[0]?.slice(0, 100) ?? 'Untitled';
      body = input.text; source = 'text';
    } else if (input.kind === 'url') {
      let url: URL;
      try { url = new URL(input.url); } catch { throw new KnowledgeError('INVALID_NOTE', 'Expected an HTTP or HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new KnowledgeError('INVALID_NOTE', 'Expected an HTTP or HTTPS URL');
      title = input.title ?? url.hostname;
      body = `# ${title}\n\n<${url.href}>\n`; source = url.href;
    } else if (input.kind === 'file') {
      title = input.title ?? input.name.replace(/\.[^.]+$/, '');
      body = /\.md$/i.test(input.name) ? new TextDecoder('utf-8', { fatal: true }).decode(input.bytes) : `# ${title}\n\n![[${await attach(input.name, input.bytes)}]]\n`;
      source = 'file';
    } else {
      title = input.snapshot.title || input.snapshot.kind;
      const embeds: string[] = [];
      if (input.snapshot.media.length && !this.options.resolveMedia) throw new KnowledgeError('INVALID_ATTACHMENT', 'A media resolver is required to ingest canvas media');
      for (const media of input.snapshot.media) {
        const resolved = await this.options.resolveMedia!(media);
        embeds.push(`![[${await attach(resolved.name || media.name, resolved.bytes)}]]`);
      }
      body = `# ${title}\n\n${input.snapshot.prompt}\n\n## Parameters\n\n\`\`\`json\n${JSON.stringify(input.snapshot.params, null, 2)}\n\`\`\`\n\n${embeds.join('\n')}\n`;
      source = 'canvas';
    }
    progress('note');
    const content = updateFrontmatter(body, { source, created: (this.options.now?.() ?? new Date()).toISOString(), ...(input.kind === 'canvas' ? { kind: input.snapshot.kind } : {}) });
    const notePath = await this.createNote(title, content, input.folder);
    progress('done');
    return { notePath, attachmentPaths };
  }
  async organize(kind: OrganizeKind, paths: string[], model = this.options.model): Promise<OrganizeResult> {
    if (!model) throw new KnowledgeError('MODEL_UNAVAILABLE', 'Select an organization model first');
    if (!paths.length || paths.length > MAX_ORGANIZE_NOTES) throw new KnowledgeError('INVALID_ORGANIZE_RESULT', `Select between 1 and ${MAX_ORGANIZE_NOTES} notes`);
    const notes = await Promise.all([...new Set(paths)].map(path => this.read(path)));
    if (notes.reduce((total, note) => total + note.content.length, 0) > MAX_ORGANIZE_CHARACTERS) {
      throw new KnowledgeError('INVALID_ORGANIZE_RESULT', `Selected notes exceed ${MAX_ORGANIZE_CHARACTERS} characters; select fewer or shorter notes`);
    }
    const result = validateOrganizeResult(await model(buildOrganizePrompt(kind, notes)), kind);
    await this.applyOrganize(result, notes);
    return result;
  }
  async applyOrganize(result: OrganizeResult, notes?: VaultNote[]): Promise<void> {
    const selected = notes ?? await this.io.readNotes(this.root, this.entries.filter(entry => entry.kind === 'note').map(entry => entry.path));
    // Build and validate the complete edit plan before the first write.
    const edits = buildOrganizeEdits(result, selected);
    const current = await this.io.readNotes(this.root, selected.map(note => note.path));
    const original = new Map(selected.map(note => [note.path, note.content]));
    if (current.some(note => original.get(note.path) !== note.content)) {
      throw new KnowledgeError('STALE_OPERATION', 'A selected note changed while the model was organizing it');
    }
    // Write all note bodies before any move: each rename then rewrites wikilinks without a later stale write undoing it.
    for (const edit of [...edits.filter(edit => edit.kind !== 'move'), ...edits.filter(edit => edit.kind === 'move')]) {
      if (edit.kind === 'write') await this.io.writeNote(this.root, edit.path, edit.content, false);
      else if (edit.kind === 'create') await this.createNote(edit.title, edit.content);
      else {
        const basename = edit.from.split('/').at(-1)!;
        const desired = `${edit.folder ? `${edit.folder}/` : ''}${basename}`;
        if (desired === edit.from) continue;
        await this.createUnique(desired, path => this.io.rename(this.root, edit.from, path));
      }
    }
    await this.refresh(true);
  }
}
/** The caller owns cleanup; polling is single-flight and never starts a second refresh mid-scan. */
export function startKnowledgePolling(service: KnowledgeService, onRefresh: (tree: VaultEntry[]) => void, onError: (error: KnowledgeError) => void, intervalMs = 3000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async (): Promise<void> => {
    try { const tree = await service.refresh(); if (!stopped) onRefresh(tree); }
    catch (error) { if (!stopped) onError(asKnowledgeError(error)); }
    if (!stopped) timer = setTimeout(() => { void poll(); }, Math.max(500, intervalMs));
  };
  timer = setTimeout(() => { void poll(); }, Math.max(500, intervalMs));
  return () => { stopped = true; clearTimeout(timer); };
}
