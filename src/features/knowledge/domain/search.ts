import { extractWikiLinks, frontmatterStrings, noteTags, noteTitle, parseMarkdown } from './markdown';
import type { KnowledgeSearchQuery, KnowledgeSearchResult, VaultNote, WikiLink } from './types';
interface IndexedNote { path: string; title: string; titleLower: string; aliasesLower: string[]; tags: string[]; tagsLower: string[]; body: string; bodyLower: string; links: WikiLink[] }
export interface KnowledgeBacklink { path: string; title: string; links: WikiLink[] }
export class KnowledgeSearchIndex {
  private readonly notes = new Map<string, IndexedNote>();
  upsert(note: VaultNote): void {
    const parsed = parseMarkdown(note.content);
    const title = noteTitle(note.path, parsed.body);
    const tags = noteTags(parsed);
    const aliases = typeof parsed.frontmatter.aliases === 'string' ? [parsed.frontmatter.aliases] : frontmatterStrings(parsed.frontmatter.aliases);
    this.notes.set(note.path, { path: note.path, title, titleLower: title.toLocaleLowerCase(), aliasesLower: aliases.map(alias => alias.toLocaleLowerCase()), tags, tagsLower: tags.map(tag => tag.toLocaleLowerCase()), body: parsed.body, bodyLower: parsed.body.toLocaleLowerCase(), links: extractWikiLinks(parsed.body) });
  }
  remove(path: string): void { this.notes.delete(path); }
  clear(): void { this.notes.clear(); }
  search(input: KnowledgeSearchQuery | string): KnowledgeSearchResult[] {
    const query = typeof input === 'string' ? { text: input } : input;
    const tokens = (query.text ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const tags = [...tokens.filter(token => token.startsWith('#')).map(token => token.slice(1)), ...(query.tag ? [query.tag.replace(/^#/, '').toLocaleLowerCase()] : [])];
    const terms = tokens.filter(token => !token.startsWith('#'));
    const titleFilter = query.title?.toLocaleLowerCase();
    const results: KnowledgeSearchResult[] = [];
    for (const note of this.notes.values()) {
      if (tags.some(tag => !note.tagsLower.includes(tag)) || (titleFilter && !note.titleLower.includes(titleFilter))) continue;
      let score = tags.length * 40 + (titleFilter ? 60 : 0);
      let firstMatch = -1;
      let matched = true;
      for (const term of terms) {
        const title = note.titleLower.includes(term);
        const alias = note.aliasesLower.some(value => value.includes(term));
        const tag = note.tagsLower.some(value => value.includes(term));
        const bodyAt = note.bodyLower.indexOf(term);
        if (!title && !alias && !tag && bodyAt < 0) { matched = false; break; }
        score += note.titleLower === term ? 100 : title ? 60 : 0;
        score += alias ? 45 : 0;
        score += tag ? 35 : 0;
        score += bodyAt >= 0 ? 10 : 0;
        if (bodyAt >= 0 && (firstMatch < 0 || bodyAt < firstMatch)) firstMatch = bodyAt;
      }
      if (!matched) continue;
      const start = Math.max(0, firstMatch < 0 ? 0 : firstMatch - 55);
      const end = Math.min(note.body.length, start + 180);
      const snippet = `${start > 0 ? '…' : ''}${note.body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < note.body.length ? '…' : ''}`;
      results.push({ path: note.path, title: note.title, tags: [...note.tags], score, snippet });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.max(1, Math.min(500, query.limit ?? 100)));
  }
  backlinks(targetPath: string): KnowledgeBacklink[] {
    const byPath = new Map<string, string>();
    const byName = new Map<string, string | null>();
    for (const path of this.notes.keys()) {
      const stem = path.replace(/\.md$/i, '');
      byPath.set(stem, path);
      const name = stem.split('/').at(-1)!;
      byName.set(name, byName.has(name) ? null : path);
    }
    const result: KnowledgeBacklink[] = [];
    for (const note of this.notes.values()) {
      const parent = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/') + 1) : '';
      const links = note.links.filter(link => {
        const target = link.target.replace(/^\.\//, '').replace(/\.md$/i, '');
        const resolved = !target ? note.path : byPath.get(target) ?? byPath.get(parent + target) ?? byName.get(target);
        return resolved === targetPath;
      });
      if (links.length && note.path !== targetPath) result.push({ path: note.path, title: note.title, links });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  tags(): string[] { return [...new Set([...this.notes.values()].flatMap(note => note.tags))].sort(); }
}
