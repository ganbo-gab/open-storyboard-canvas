import { KnowledgeError, assertVaultRelativePath, type VaultEntry } from './types';

/** Matches the existing native video-byte ceiling; never load an unbounded file into IPC. */
export const MAX_KNOWLEDGE_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export interface KnowledgeAttachment extends VaultEntry { kind: 'attachment'; mediaType: string }
export interface KnowledgeAttachmentImport {
  name: string;
  bytes: Uint8Array;
  /** Optional directory relative to attachments/, never an absolute import-source path. */
  folder?: string;
}
export interface KnowledgeAttachmentContent { attachment: KnowledgeAttachment; bytes: Uint8Array }

export function assertAttachmentPath(path: string): string {
  assertVaultRelativePath(path);
  if (!path.startsWith('attachments/') || /\.md$/i.test(path)) {
    throw new KnowledgeError('INVALID_ATTACHMENT', 'Expected a non-Markdown file under attachments/');
  }
  return path;
}
export function assertAttachmentBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_KNOWLEDGE_ATTACHMENT_BYTES) {
    throw new KnowledgeError('INVALID_ATTACHMENT', 'Attachment bytes must not exceed 512 MiB');
  }
}
const mediaTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', zip: 'application/zip',
};
/** Extension-derived download metadata only, not content verification or permission to execute a file. */
export function attachmentMetadata(entry: VaultEntry): KnowledgeAttachment {
  assertAttachmentPath(entry.path);
  if (entry.kind !== 'attachment') throw new KnowledgeError('INVALID_ATTACHMENT', 'Expected an attachment file');
  const extension = entry.name.split('.').at(-1)?.toLowerCase() ?? '';
  return { ...entry, kind: 'attachment', mediaType: Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : 'application/octet-stream' };
}
