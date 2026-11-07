import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ComposerReference } from './useNodeReferences';

export function normalizeReferenceTriggers(text: string, references: readonly ComposerReference[]): string {
  for (const reference of references) {
    const token = reference.token.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`[@＠]{2,}${token}(?![0-9])`, 'g'), reference.token);
  }
  return text;
}
/** Persistence stays plain text; only exact currently known markers become atoms. */
export function promptDocument(text: string, references: readonly ComposerReference[]): JSONContent {
  text = normalizeReferenceTriggers(text, references);
  const ordered = [...references].sort((left, right) => right.token.length - left.token.length);
  return { type: 'doc', content: text.split('\n').map((line) => {
    const content: JSONContent[] = []; let cursor = 0; let plain = '';
    const flush = () => { if (plain) { content.push({ type: 'text', text: plain }); plain = ''; } };
    while (cursor < line.length) {
      const reference = line[cursor] === '@' ? ordered.find((entry) => line.startsWith(entry.token, cursor)
        && !(/\d$/.test(entry.token) && /\d/.test(line[cursor + entry.token.length] ?? ''))) : undefined;
      if (reference) { flush(); content.push({ type: 'promptReference', attrs: { token: reference.token, title: reference.title, source: reference.displayUrl ?? '' } }); cursor += reference.token.length; }
      else { plain += line[cursor]; cursor += 1; }
    }
    flush(); return { type: 'paragraph', ...(content.length ? { content } : {}) };
  }) };
}

function leafText(node: ProseMirrorNode): string { return node.type.name === 'promptReference' ? String(node.attrs.token ?? '') : node.type.name === 'hardBreak' ? '\n' : ''; }
/** Editor positions count atoms as one; the persisted selection uses their text length. */
export function promptTextOffset(doc: ProseMirrorNode, position: number): number {
  return doc.textBetween(0, position, '\n', leafText).length;
}
export function promptPositionAtOffset(doc: ProseMirrorNode, offset: number): number {
  let remaining = Math.max(0, offset); let found: number | undefined;
  doc.forEach((block, blockOffset, blockIndex) => {
    if (found !== undefined) return;
    if (blockIndex > 0) remaining -= 1;
    if (remaining <= 0) { found = blockOffset + 1; return; }
    block.forEach((node, nodeOffset) => {
      if (found !== undefined) return;
      const length = node.isText ? node.text?.length ?? 0 : leafText(node).length;
      if (remaining <= length) found = blockOffset + 1 + nodeOffset + (node.isText ? remaining : remaining ? node.nodeSize : 0);
      else remaining -= length;
    });
    if (found === undefined && remaining === 0) found = blockOffset + block.nodeSize - 1;
  });
  return found ?? Math.max(1, doc.content.size - 1);
}
