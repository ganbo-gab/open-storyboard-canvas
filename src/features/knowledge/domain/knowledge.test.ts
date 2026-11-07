import { describe, expect, it } from 'vitest';
import { addNoteTags, extractWikiLinks, noteTags, parseMarkdown, serializeMarkdown, updateFrontmatter } from './markdown';
import { assertVaultRelativePath } from './types';
import { KnowledgeSearchIndex } from './search';

describe('knowledge Markdown', () => {
  it('round-trips unknown YAML keys and exact CRLF/body bytes', () => {
    const content = '\uFEFF---\r\ntags: [film, "场景/灯光"]\r\naliases:\r\n  - The alias\r\ncreated: 2026-10-25\r\nsource: canvas\r\ncustom: # preserve comment\r\n  nested: [1, true, null]\r\n---\r\n\r\n# 标题\r\nbody  \r\n\r\n';
    const parsed = parseMarkdown(content);
    expect(serializeMarkdown(parsed)).toBe(content);
    expect(parsed.frontmatter.custom).toEqual({ nested: [1, true, null] });
    const updated = addNoteTags(content, ['new']);
    expect(parseMarkdown(updated).body).toBe(parsed.body);
    expect(parseMarkdown(updated).frontmatter.custom).toEqual({ nested: [1, true, null] });
    expect(updated).toContain('# preserve comment');
    expect(parseMarkdown(updated).frontmatter.tags).toEqual(['film', '场景/灯光', 'new']);
  });
  it('preserves headerless body and recognizes frontmatter only at the beginning', () => {
    for (const content of ['', 'plain body  \n', '# Title\n\n---\nnot: metadata\n---\n']) expect(serializeMarkdown(parseMarkdown(content))).toBe(content);
    expect(parseMarkdown(updateFrontmatter('body\n', { source: 'text' })).body).toBe('body\n');
    expect(() => parseMarkdown('---\n- sequence\n---\nbody')).toThrow();
    expect(() => parseMarkdown('---\ntags: [unclosed\n---\nbody')).toThrow();
  });
  it('extracts tags, links, embeds and headings but not code', () => {
    const body = '# Heading\n#电影 #shot/day #123\n[[Notes/Scene#Light|label]] ![[attachments/a.png|200]]\n`[[ignore]] #ignore`\n```md\n[[skip]] #skip\n```\n';
    expect(noteTags(parseMarkdown(`---\ntags: [film]\n---\n${body}`))).toEqual(['film', '电影', 'shot/day']);
    const links = extractWikiLinks(body);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: 'Notes/Scene', heading: 'Light', alias: 'label', embed: false });
    expect(links[1]).toMatchObject({ target: 'attachments/a.png', alias: '200', embed: true });
    expect(body.slice(links[1].start, links[1].end)).toBe('![[attachments/a.png|200]]');
  });
});
describe('knowledge paths', () => {
  it.each(['../x.md', '/tmp/x.md', 'folder/../../x.md', 'C:/x.md', 'C:\\x.md', '//server/x', '.obsidian/config', '.trash/a.md', 'a//x.md', 'a/./x.md', 'a\0.md'])('rejects %s', path => expect(() => assertVaultRelativePath(path)).toThrow());
  it('accepts Unicode vault-relative paths', () => expect(assertVaultRelativePath('目录/笔记.md')).toBe('目录/笔记.md'));
  it.each(['attachments/%2e%2e/private.bin', 'attachments/%252e%252e/private.bin', 'attachments/a%2fb.bin', 'attachments/a%5cb.bin', '.OBSIDIAN/config', 'nested/.TRASH/a.bin', 'attachments/.knowledge-staged.bin'])('rejects encoded and reserved paths %s', path => expect(() => assertVaultRelativePath(path)).toThrow());
});
describe('knowledge search', () => {
  it('ranks exact title above tag above body and returns matching snippets', () => {
    const index = new KnowledgeSearchIndex();
    index.upsert({ path: 'Title.md', content: '# Camera\nA lens note' });
    index.upsert({ path: 'Tags.md', content: '---\ntags: [camera]\n---\n# Tags\nlighting' });
    index.upsert({ path: 'Body.md', content: `# Story\n${'prefix '.repeat(50)}camera movement ${'suffix '.repeat(50)}` });
    expect(index.search('camera').map(result => result.path)).toEqual(['Title.md', 'Tags.md', 'Body.md']);
    const snippet = index.search({ text: 'camera', title: 'story' })[0].snippet;
    expect(snippet).toContain('camera movement'); expect(snippet.startsWith('…')).toBe(true); expect(snippet.length).toBeLessThan(190);
    expect(index.search('#camera').map(result => result.path)).toEqual(['Tags.md']);
    expect(index.search({ tag: 'camera', title: 'tags' })).toHaveLength(1);
    index.remove('Tags.md'); expect(index.search('#camera')).toEqual([]);
  });
  it('indexes 5k notes and resolves backlinks without confusing duplicate basenames', () => {
    const index = new KnowledgeSearchIndex();
    for (let i = 0; i < 5000; i++) index.upsert({ path: `Note ${i}.md`, content: `# Note ${i}\nbody ${i}` });
    index.upsert({ path: 'folder/Target.md', content: '# Target' });
    index.upsert({ path: 'other/Target.md', content: '# Duplicate' });
    index.upsert({ path: 'folder/Source.md', content: '[[Target#Section]] [[Note 42]]' });
    index.upsert({ path: 'Ambiguous.md', content: '[[Target]]' });
    expect(index.search({ title: 'note 4999' })).toHaveLength(1);
    expect(index.backlinks('folder/Target.md').map(note => note.path)).toEqual(['folder/Source.md']);
    expect(index.backlinks('Note 42.md').map(note => note.path)).toEqual(['folder/Source.md']);
  });
});
