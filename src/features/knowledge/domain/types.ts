import { z } from 'zod';

const knowledgeErrorCodeSchema = z.enum(['UNSAFE_PATH', 'INVALID_VAULT', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'IO_ERROR', 'INVALID_NOTE', 'INVALID_ATTACHMENT', 'PARTIAL_RENAME', 'INVALID_FRONTMATTER', 'INVALID_ORGANIZE_RESULT', 'MODEL_UNAVAILABLE', 'VAULT_UNSET', 'STALE_OPERATION']);
export type KnowledgeErrorCode = z.infer<typeof knowledgeErrorCodeSchema>;
export class KnowledgeError extends Error {
  constructor(public readonly code: KnowledgeErrorCode, message: string) { super(message); this.name = 'KnowledgeError'; }
}
const knowledgeErrorSchema = z.object({
  code: knowledgeErrorCodeSchema,
  message: z.string(),
});
export function asKnowledgeError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  const parsed = knowledgeErrorSchema.safeParse(error);
  if (parsed.success) return new KnowledgeError(parsed.data.code, parsed.data.message);
  return new KnowledgeError('IO_ERROR', error instanceof Error ? error.message : String(error));
}
export interface VaultEntry { path: string; name: string; kind: 'folder' | 'note' | 'attachment'; modifiedAt: number; size: number }
export interface VaultNote { path: string; content: string }
export const vaultEntrySchema = z.object({
  path: z.string().min(1), name: z.string().min(1), kind: z.enum(['folder', 'note', 'attachment']),
  modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const vaultNoteSchema = z.object({ path: z.string().min(1), content: z.string() }).strict();

/** Validate explicit paths without resolving or expanding environment variables or ~. */
export function assertVaultRoot(root: string): string {
  if (typeof root !== 'string' || !root || /[\u0000-\u001f]/.test(root) || !(/^\//.test(root) || /^[a-z]:[\\/]/i.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root))) {
    throw new KnowledgeError('INVALID_VAULT', 'Vault root must be an explicit absolute directory path');
  }
  return root;
}
export interface WikiLink { target: string; heading?: string; alias?: string; embed: boolean; start: number; end: number }
export interface KnowledgeSearchQuery { text?: string; tag?: string; title?: string; limit?: number }
export interface KnowledgeSearchResult { path: string; title: string; tags: string[]; score: number; snippet: string }
export interface CanvasSnapshotMedia { reference: string; name: string }
export interface CanvasNodeSnapshot { kind: string; title: string; prompt: string; params: Record<string, unknown>; media: CanvasSnapshotMedia[] }
export type KnowledgeIngestInput =
  | { kind: 'text'; text: string; title?: string; folder?: string }
  | { kind: 'url'; url: string; title?: string; folder?: string }
  | { kind: 'file'; name: string; bytes: Uint8Array; title?: string; folder?: string }
  | { kind: 'canvas'; snapshot: CanvasNodeSnapshot; folder?: string };
export interface IngestProgress { completed: number; total: number; stage: 'attachment' | 'note' | 'done' }
export interface KnowledgeIngestResult { notePath: string; attachmentPaths: string[] }

/** Defense in depth; Rust also checks existing ancestors against symlinks. */
export function assertVaultRelativePath(path: string): string {
  const parts = path.split('/');
  if (!path || /[\\:<>"|?*\u0000-\u001f]/.test(path) || /%[0-9a-f]{2}/i.test(path) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || ['.obsidian', '.trash'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.knowledge-'))) {
    throw new KnowledgeError('UNSAFE_PATH', 'Expected a safe vault-relative path');
  }
  return path;
}
export function assertNotePath(path: string): string {
  assertVaultRelativePath(path);
  if (!/\.md$/i.test(path)) throw new KnowledgeError('INVALID_NOTE', 'Notes must use the .md extension');
  return path;
}
