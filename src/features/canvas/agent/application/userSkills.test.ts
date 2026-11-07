import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillContext, listSkillsForSurface, resolveAgentToolPolicy } from './agentSkills';
import { createAgentSkillStore, createSkillFromGroup, parseSkillMarkdown, serializeSkill, useAgentSkillStore, type SkillDraft, type UserAgentSkill } from './userSkills';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { LocalDocument } from '@/features/workbench/application/workbenchPersistence';

const draft: SkillDraft = { name: 'Continuity: 猫', description: 'Preserve character identity', surface: 'canvas', tools: ['canvas_command', 'asset_read'],
  instructions: '# Instructions\n\nKeep {{character}} consistent.\n---\nAsk before paid generation.' };
const saved = (id: string, surface: SkillDraft['surface'], tools = draft.tools): UserAgentSkill => ({ ...draft, id, surface, tools, source: 'user', createdAt: 1, updatedAt: 1 });

beforeEach(() => useAgentSkillStore.setState({ skills: [], initialized: true }));
afterEach(() => useAgentSkillStore.setState({ skills: [], initialized: false }));

describe('user skill Markdown and storage', () => {
  it('round-trips Unicode, multiline instructions, colon metadata and placeholders without identity metadata', () => {
    const text = serializeSkill({ ...saved('user-skill-one', 'canvas') });
    expect(parseSkillMarkdown(text)).toEqual(draft);
    expect(text).not.toContain('user-skill-one');
    expect(parseSkillMarkdown(text.replace(/\n/g, '\r\n'))).toEqual(draft);
  });

  it.each([
    'name: Test\ndescription: Test\nsurface: unknown\ntools: []',
    'name: Test\ndescription: Test\nsurface: canvas\ntools: [shell]',
    'name: Test\ndescription: Test\nsurface: canvas\ntools: [canvas_command, canvas_command]',
    'name: Test\nname: Duplicate\ndescription: Test\nsurface: all\ntools: []',
    'name: Test\ndescription: Test\nsurface: all\ntools: []\nextra: forbidden',
    'name: Test\ndescription: Test\nsurface: all\ntools: canvas_command',
  ])('rejects invalid frontmatter without accepting hidden capabilities: %s', (header) => {
    expect(() => parseSkillMarkdown(`---\n${header}\n---\nInstructions`)).toThrow();
  });

  it('requires complete frontmatter and nonempty instructions', () => {
    expect(() => parseSkillMarkdown('# Just Markdown')).toThrow();
    expect(() => parseSkillMarkdown('---\nname: Incomplete')).toThrow();
    expect(() => parseSkillMarkdown('---\nname: Test\ndescription: Test\nsurface: all\ntools: []\n---\n ')).toThrow();
  });

  it('hydrates once before writes, persists edits/imports/removals, and never edits built-ins', async () => {
    let data = [saved('user-skill-existing', 'home')];
    let initialized = false;
    const storage: LocalDocument<UserAgentSkill[]> = {
      initialize: async () => { initialized = true; }, load: () => structuredClone(data),
      save: (next) => { expect(initialized).toBe(true); data = structuredClone(next); }, status: () => ({ mode: 'persistent' }), flush: async () => {},
    };
    const store = createAgentSkillStore(storage);
    const [created, imported] = await Promise.all([store.getState().create(draft), store.getState().importMarkdown(serializeSkill(draft))]);
    expect(store.getState().skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(['user-skill-existing', created.id, imported.id]));
    await store.getState().update(created.id, { description: 'Updated', tools: [] });
    expect(parseSkillMarkdown(store.getState().exportMarkdown(created.id))).toMatchObject({ description: 'Updated', tools: [] });
    await expect(store.getState().update('image-prompt-director', { name: 'Mutated' })).rejects.toThrow();
    await expect(store.getState().remove('image-prompt-director')).rejects.toThrow();
    await store.getState().remove(imported.id);
    const reloaded = createAgentSkillStore(storage);
    await reloaded.getState().initialize();
    expect(reloaded.getState().skills).toEqual(data);
    expect(reloaded.getState().skills.some((skill) => skill.id === imported.id)).toBe(false);
  });

  it('exposes session-only storage status instead of claiming durable persistence', async () => {
    let data: UserAgentSkill[] = [];
    const store = createAgentSkillStore({ load: () => data, save: (next) => { data = next; }, status: () => ({ mode: 'memory', reason: 'Unavailable' }) });
    await store.getState().create(draft);
    expect(store.getState()).toMatchObject({ initialized: true, storageStatus: { mode: 'memory' }, skills: [expect.objectContaining({ name: draft.name })] });
  });
});

describe('surface skill selection and least privilege', () => {
  it('lists applicable built-in and user skills with source tags', () => {
    useAgentSkillStore.setState({ skills: [saved('user-skill-canvas', 'canvas'), saved('user-skill-home', 'home'), saved('user-skill-all', 'all')] });
    const home = listSkillsForSurface('home');
    expect(home.filter((skill) => skill.source === 'user').map((skill) => skill.id)).toEqual(['user-skill-home', 'user-skill-all']);
    expect(home.some((skill) => skill.id === 'canvas-orchestration')).toBe(false);
    expect(listSkillsForSurface('stage').some((skill) => skill.id === 'director-studio' && skill.source === 'builtin')).toBe(true);
    expect(buildSkillContext({ text: draft.name, surface: 'stage' }).selections.map((selection) => selection.skill.id)).toEqual(['user-skill-all']);
  });

  it('always includes explicit choices even across surface filters and beyond automatic routing budget', () => {
    useAgentSkillStore.setState({ skills: Array.from({ length: 4 }, (_, index) => saved(`user-skill-${index}`, 'home')) });
    const ids = useAgentSkillStore.getState().skills.map((skill) => skill.id);
    const context = buildSkillContext({ text: '你好', surface: 'canvas', explicitSkillIds: [...ids, 'director-studio'] });
    expect(context.selections.map((selection) => selection.skill.id)).toEqual(expect.arrayContaining([...ids, 'director-studio']));
    expect(context.instructions).toContain(draft.instructions);
  });

  it('intersects selected whitelists and never widens the routed native tool policy', () => {
    useAgentSkillStore.setState({ skills: [saved('user-skill-narrow', 'canvas', ['canvas_command']), saved('user-skill-empty', 'all', [])] });
    const text = '用参考图写图片生成提示词并检查供应商配置';
    const baseline = resolveAgentToolPolicy({ skillContext: buildSkillContext({ text }), supportsVision: true, supportsToolSearch: false });
    const narrowed = buildSkillContext({ text, explicitSkillIds: ['user-skill-narrow'] });
    const policy = resolveAgentToolPolicy({ skillContext: narrowed, supportsVision: true, supportsToolSearch: false });
    expect(policy.allowedToolNames).toEqual(['canvas_command']);
    expect(policy.toolKinds).toEqual(['canvas']);
    expect(policy.toolKinds.every((kind) => baseline.toolKinds.includes(kind))).toBe(true);
    const empty = buildSkillContext({ text, explicitSkillIds: ['user-skill-narrow', 'user-skill-empty'] });
    expect(empty.allowedToolNames).toEqual([]);
    expect(resolveAgentToolPolicy({ skillContext: empty, supportsVision: true, supportsToolSearch: false }).toolKinds).toEqual([]);
    expect(resolveAgentToolPolicy({ skillContext: buildSkillContext({ text: '你好', explicitSkillIds: ['user-skill-narrow'] }), supportsVision: true, supportsToolSearch: false }).toolKinds).toEqual([]);
    const removed = buildSkillContext({ text, explicitSkillIds: ['user-skill-no-longer-present'] });
    expect(removed.allowedToolNames).toEqual([]);
    expect(resolveAgentToolPolicy({ skillContext: removed, supportsVision: true, supportsToolSearch: false }).toolKinds).toEqual([]);
  });
});

describe('group to editable skill', () => {
  it('captures three-node types, parameters, directed handles and varying prompt templates without saving', () => {
    const nodes: CanvasNode[] = [
      { id: 'group', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: 'Cat sequence' } },
      { id: 'script', type: CANVAS_NODE_TYPES.textAnnotation, parentId: 'group', position: { x: 0, y: 0 }, data: { content: 'A cat crosses the street.' } },
      { id: 'shot-a', type: CANVAS_NODE_TYPES.imageEdit, parentId: 'group', position: { x: 100, y: 0 }, data: { label: 'First', prompt: 'Cinematic cat in the rain', model: 'image-model', aspectRatio: '16:9' } },
      { id: 'shot-b', type: CANVAS_NODE_TYPES.imageEdit, parentId: 'group', position: { x: 200, y: 0 }, data: { label: 'Second', prompt: 'Cinematic cat under the bridge' } },
      { id: 'outside', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 300, y: 0 }, data: { content: 'Do not include' } },
    ];
    const before = structuredClone(nodes);
    const result = createSkillFromGroup('group', nodes, [
      { id: 'one', source: 'script', target: 'shot-a', sourceHandle: 'text', targetHandle: 'prompt' },
      { id: 'two', source: 'shot-a', target: 'shot-b' },
      { id: 'outside-edge', source: 'outside', target: 'shot-b' },
    ]);
    expect(result.surface).toBe('canvas');
    expect(result.instructions).toContain('textAnnotationNode');
    expect(result.instructions).toContain('imageNode');
    expect(result.instructions).toContain('node_1 [text] -> node_2 [prompt]');
    expect(result.instructions).toContain('node_2 -> node_3');
    expect(result.instructions).toContain('Cinematic cat {{node_2_prompt}}');
    expect(result.instructions).toContain('in the rain');
    expect(result.instructions).toContain('under the bridge');
    expect(result.instructions).not.toContain('Do not include');
    expect(result.instructions).toContain('aspectRatio="16:9"');
    expect(nodes).toEqual(before);
    expect(useAgentSkillStore.getState().skills).toEqual([]);
    expect(parseSkillMarkdown(serializeSkill(result))).toEqual(result);
  });
});
