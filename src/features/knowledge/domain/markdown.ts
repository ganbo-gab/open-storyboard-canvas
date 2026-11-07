import { isMap, parseDocument } from 'yaml';
import { KnowledgeError, type WikiLink } from './types';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  /** Exact original header, including delimiters/newlines; empty when absent. */
  header: string;
  body: string;
  newline: '\n' | '\r\n';
}
export function parseMarkdown(content: string): ParsedMarkdown {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match || match.index !== 0) return { frontmatter: {}, header: '', body: content, newline };
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length || (document.contents !== null && !isMap(document.contents))) {
    throw new KnowledgeError('INVALID_FRONTMATTER', document.errors[0]?.message ?? 'Frontmatter must be a YAML mapping');
  }
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  const frontmatter = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { frontmatter, header: match[0], body: content.slice(match[0].length), newline };
}
/** No-op parse/serialize is byte-for-byte, including unfamiliar YAML and body whitespace. */
export function serializeMarkdown(note: ParsedMarkdown): string { return note.header + note.body; }
export function updateFrontmatter(content: string, patch: Record<string, unknown>): string {
  const note = parseMarkdown(content);
  const yaml = note.header ? note.header.replace(/^(?:\uFEFF)?---[ \t]*\r?\n/, '').replace(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)$/m, '') : '';
  const document = parseDocument(yaml);
  for (const [key, value] of Object.entries(patch)) document.set(key, value);
  const header = document.toString({ lineWidth: 0 }).replace(/\r?\n/g, note.newline);
  return `---${note.newline}${header}---${note.newline}${note.body}`;
}
export function frontmatterStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,\s]+/).map(item => item.replace(/^#/, '')).filter(Boolean);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.replace(/^#/, '')) : [];
}
/** Masks code while retaining string offsets for links/tags. */
function prose(body: string): string {
  return body.replace(/^([ \t]*)(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^\1\2[^\r\n]*(?:\r?\n|$)/gm, value => value.replace(/[^\r\n]/g, ' '))
    .replace(/(`+)[^`\r\n]*?\1/g, value => ' '.repeat(value.length));
}
export function extractWikiLinks(body: string): WikiLink[] {
  const result: WikiLink[] = [];
  for (const match of prose(body).matchAll(/(!?)\[\[([^\]\r\n]+)\]\]/g)) {
    const [destination, ...alias] = match[2].split('|');
    const split = destination.indexOf('#');
    result.push({ target: (split < 0 ? destination : destination.slice(0, split)).trim(), heading: split < 0 ? undefined : destination.slice(split + 1), alias: alias.length ? alias.join('|') : undefined, embed: match[1] === '!', start: match.index, end: match.index + match[0].length });
  }
  return result;
}
export function noteTags(note: ParsedMarkdown): string[] {
  const inline = [...prose(note.body).matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)(?![\p{L}\p{N}_\-/])/gu)].map(match => match[1]).filter(tag => !/^\d+$/.test(tag));
  return [...new Set([...frontmatterStrings(note.frontmatter.tags), ...inline])];
}
export function noteTitle(path: string, body: string): string {
  return /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? path.split('/').at(-1)!.replace(/\.md$/i, '');
}
export function addNoteTags(content: string, tags: string[]): string {
  const note = parseMarkdown(content);
  return updateFrontmatter(content, { tags: [...new Set([...frontmatterStrings(note.frontmatter.tags), ...tags.map(tag => tag.replace(/^#/, ''))])] });
}
export function resolveWikiTarget(target: string, fromPath: string, paths: readonly string[]): string | undefined {
  if (!target) return fromPath;
  const normalized = target.replace(/^\.\//, '').replace(/\.md$/i, '');
  const parent = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  for (const candidate of [normalized, parent + normalized]) {
    const found = paths.find(path => path.replace(/\.md$/i, '') === candidate);
    if (found) return found;
  }
  const matches = paths.filter(path => path.split('/').at(-1)!.replace(/\.md$/i, '') === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}
