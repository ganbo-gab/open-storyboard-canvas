import { z } from 'zod';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { loadImage } from '@/commands/image';
import { getAssetPortableSource } from '@/features/assets/application/assetMediaStorage';
import type { KnowledgeMediaResolver, KnowledgeVaultIO } from '../application/ports';
import { assertNotePath, assertVaultRelativePath, assertVaultRoot, KnowledgeError, vaultEntrySchema, vaultNoteSchema } from '../domain/types';
import { assertAttachmentBytes, assertAttachmentPath } from '../domain/attachments';

export const tauriKnowledgeIO: KnowledgeVaultIO = {
  initVault: async root => assertVaultRoot(z.string().parse(await invoke<unknown>('knowledge_init_vault', { root: assertVaultRoot(root) }))),
  openVault: async root => assertVaultRoot(z.string().parse(await invoke<unknown>('knowledge_open_vault', { root: assertVaultRoot(root) }))),
  listTree: async root => z.array(vaultEntrySchema).parse(await invoke<unknown>('knowledge_list_tree', { root: assertVaultRoot(root) })),
  readNote: async (root, path) => z.string().parse(await invoke<unknown>('knowledge_read_note', { root: assertVaultRoot(root), path: assertNotePath(path) })),
  readNotes: async (root, paths) => z.array(vaultNoteSchema).parse(await invoke<unknown>('knowledge_read_notes', { root: assertVaultRoot(root), paths: paths.map(assertNotePath) })),
  writeNote: (root, path, content, createOnly) => invoke<void>('knowledge_write_note', { root: assertVaultRoot(root), path: assertNotePath(path), content, createOnly }),
  writeAttachment: (root, path, bytes, createOnly) => {
    assertAttachmentBytes(bytes);
    return invoke<void>('knowledge_write_attachment', { root: assertVaultRoot(root), path: assertAttachmentPath(path), bytes: Array.from(bytes), createOnly });
  },
  readAttachment: async (root, path) => {
    const response = await invoke<unknown>('knowledge_read_attachment', { root: assertVaultRoot(root), path: assertAttachmentPath(path) });
    const bytes = new Uint8Array(z.instanceof(ArrayBuffer).parse(response));
    assertAttachmentBytes(bytes);
    return bytes;
  },
  removeAttachment: async (root, path) => z.string().parse(await invoke<unknown>('knowledge_remove_attachment', { root: assertVaultRoot(root), path: assertAttachmentPath(path) })),
  rename: (root, from, to) => invoke<void>('knowledge_rename', { root: assertVaultRoot(root), from: assertVaultRelativePath(from), to: assertVaultRelativePath(to) }),
  trash: async (root, path) => z.string().parse(await invoke<unknown>('knowledge_delete', { root: assertVaultRoot(root), path: assertVaultRelativePath(path) })),
  listTrash: async root => z.array(vaultEntrySchema).parse(await invoke<unknown>('knowledge_list_trash', { root: assertVaultRoot(root) })),
  restore: (root, trashPath, destination) => invoke<void>('knowledge_restore', { root: assertVaultRoot(root), trashPath: assertVaultRelativePath(trashPath), destination: assertVaultRelativePath(destination) }),
};
/** Folder chooser may return null on cancel. initVault creates an absent folder when passed explicitly. */
export async function chooseKnowledgeVault(): Promise<string | null> {
  if (!isTauri()) throw new KnowledgeError('INVALID_VAULT', 'Local knowledge vaults require the desktop application');
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}
/** Reads already-local assets only; ingest never implicitly fetches a remote URL. */
export const resolveLocalKnowledgeMedia: KnowledgeMediaResolver = async media => {
  let source = await getAssetPortableSource(media.reference);
  if (/^https?:\/\//i.test(source)) throw new KnowledgeError('INVALID_ATTACHMENT', 'Download remote canvas media before adding it to the vault');
  if (!source.startsWith('data:') && !source.startsWith('blob:')) source = await loadImage(source);
  const response = await fetch(source);
  if (!response.ok) throw new KnowledgeError('INVALID_ATTACHMENT', 'Cannot read the local media bytes');
  return { name: media.name, bytes: new Uint8Array(await response.arrayBuffer()) };
};
