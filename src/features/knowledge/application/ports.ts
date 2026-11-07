import type { CanvasSnapshotMedia, VaultEntry, VaultNote } from '../domain/types';
export interface KnowledgeVaultIO {
  /** Explicit user authorization: may create the vault and resolve an initially selected alias. */
  initVault(root: string): Promise<string>;
  /** Reopen an existing authorized canonical root unchanged, without following aliases or creating files. */
  openVault(root: string): Promise<string>;
  listTree(root: string): Promise<VaultEntry[]>;
  readNote(root: string, path: string): Promise<string>;
  readNotes(root: string, paths: string[]): Promise<VaultNote[]>;
  writeNote(root: string, path: string, content: string, createOnly: boolean): Promise<void>;
  writeAttachment(root: string, path: string, bytes: Uint8Array, createOnly: boolean): Promise<void>;
  readAttachment(root: string, path: string): Promise<Uint8Array>;
  removeAttachment(root: string, path: string): Promise<string>;
  rename(root: string, from: string, to: string): Promise<void>;
  trash(root: string, path: string): Promise<string>;
  listTrash(root: string): Promise<VaultEntry[]>;
  restore(root: string, trashPath: string, destination: string): Promise<void>;
}
export type KnowledgeMediaResolver = (media: CanvasSnapshotMedia) => Promise<{ name: string; bytes: Uint8Array }>;
