import { create } from 'zustand';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { isRegisteredAgentToolName } from '@/features/agents/domain/agentToolNames';
import { CANVAS_NODE_TYPES, isTagGroupNode, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { LocalDocument, LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';
import type { AgentScope } from '../domain/agentModel';

export type SkillSurface = AgentScope | 'all';
export interface SkillDraft {
  name: string;
  description: string;
  surface: SkillSurface;
  tools: string[];
  instructions: string;
}
export interface UserAgentSkill extends SkillDraft {
  id: string;
  source: 'user';
  createdAt: number;
  updatedAt: number;
}

const fields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  surface: z.enum(['home', 'canvas', 'stage', 'all']),
  tools: z.array(z.string().trim().min(1).refine(isRegisteredAgentToolName, 'Unknown registered Agent tool')).max(100)
    .refine((tools) => new Set(tools).size === tools.length, 'Duplicate tools are not allowed'),
  instructions: z.string().trim().min(1).max(18_000),
};
const draftSchema = z.object(fields).strict();
const frontmatterSchema = draftSchema.omit({ instructions: true });
const patchSchema = draftSchema.partial();
const savedSkillSchema = z.object({ ...fields, id: z.string().regex(/^user-skill-[a-zA-Z0-9-]+$/), source: z.literal('user'),
  createdAt: z.number().finite(), updatedAt: z.number().finite() }).strict();
const savedSkillsSchema = z.array(savedSkillSchema).refine((skills) => new Set(skills.map((skill) => skill.id)).size === skills.length, 'Duplicate skill ids');

/** Only the four documented metadata fields are accepted; aliases and duplicate YAML keys are rejected. */
export function parseSkillMarkdown(text: string): SkillDraft {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) throw new Error('Skill Markdown requires a complete YAML frontmatter block');
  const yaml = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (yaml.errors.length) throw new Error(yaml.errors.map((error) => error.message).join('; '));
  const metadata = frontmatterSchema.parse(yaml.toJS({ maxAliasCount: 0 }));
  return draftSchema.parse({ ...metadata, instructions: normalized.slice(match[0].length) });
}

export function serializeSkill(input: SkillDraft): string {
  // Select only editable fields so stored ids/timestamps never leak into the interchange format.
  const skill = draftSchema.parse({ name: input.name, description: input.description, surface: input.surface, tools: input.tools, instructions: input.instructions });
  return `---\n${stringify({ name: skill.name, description: skill.description, surface: skill.surface, tools: skill.tools }, { lineWidth: 0 })}---\n\n${skill.instructions}\n`;
}

export interface AgentSkillState {
  skills: UserAgentSkill[];
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  initialize(): Promise<void>;
  create(input: SkillDraft): Promise<UserAgentSkill>;
  update(id: string, patch: Partial<SkillDraft>): Promise<UserAgentSkill>;
  remove(id: string): Promise<void>;
  importMarkdown(text: string): Promise<UserAgentSkill>;
  exportMarkdown(id: string): string;
}

export function createAgentSkillStore(storage: LocalDocument<UserAgentSkill[]>) {
  return create<AgentSkillState>((set, get) => {
    let initializing: Promise<void> | undefined;
    const persist = async (skills: UserAgentSkill[]) => {
      storage.save(skills);
      set({ skills, storageStatus: storage.status() });
      try { await storage.flush?.(); }
      finally { set({ storageStatus: storage.status() }); }
    };
    const find = (id: string) => {
      const skill = get().skills.find((entry) => entry.id === id);
      if (!skill) throw new Error('User skill not found; built-in skills are read-only');
      return skill;
    };
    return {
      skills: [], initialized: false, storageStatus: storage.status(),
      initialize() {
        if (get().initialized) return Promise.resolve();
        if (!initializing) initializing = (async () => {
          await storage.initialize?.();
          set({ skills: savedSkillsSchema.parse(storage.load()), initialized: true, storageStatus: storage.status() });
        })().finally(() => { initializing = undefined; });
        return initializing;
      },
      async create(input) {
        const draft = draftSchema.parse(input);
        await get().initialize();
        const now = Date.now();
        const skill: UserAgentSkill = { ...draft, id: `user-skill-${crypto.randomUUID()}`, source: 'user', createdAt: now, updatedAt: now };
        await persist([...get().skills, skill]);
        return skill;
      },
      async update(id, patch) {
        const changes = patchSchema.parse(patch);
        await get().initialize();
        const skill = savedSkillSchema.parse({ ...find(id), ...changes, updatedAt: Date.now() });
        await persist(get().skills.map((entry) => entry.id === id ? skill : entry));
        return skill;
      },
      async remove(id) {
        await get().initialize();
        find(id);
        await persist(get().skills.filter((entry) => entry.id !== id));
      },
      importMarkdown: (text) => get().create(parseSkillMarkdown(text)),
      exportMarkdown: (id) => serializeSkill(find(id)),
    };
  });
}

export const useAgentSkillStore = createAgentSkillStore(createWorkspaceDocument<UserAgentSkill[]>(
  'storyboard-copilot:agent-skills:v1', () => [], (input) => savedSkillsSchema.parse(input),
));

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Draft only: the caller must present the editable result and explicitly save it. */
export function createSkillFromGroup(groupNodeId: string, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): SkillDraft {
  const group = nodes.find((node) => node.id === groupNodeId);
  if (!group || (group.type !== CANVAS_NODE_TYPES.group && !isTagGroupNode(group))) throw new Error('Select an existing canvas group');
  const memberIds = new Set(isTagGroupNode(group) ? group.data.memberNodeIds : []);
  // Include nested children regardless of input ordering, without following malformed parent cycles.
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) if (node.id !== group.id && node.parentId && (node.parentId === group.id || memberIds.has(node.parentId)) && !memberIds.has(node.id)) {
      memberIds.add(node.id); added = true;
    }
  }
  const members = nodes.filter((node) => node.id !== group.id && memberIds.has(node.id));
  if (!members.length) throw new Error('The group has no nodes to turn into a skill');
  const aliases = new Map(members.map((node, index) => [node.id, `node_${index + 1}`]));
  const defaults: string[] = [];
  const prompts = members.flatMap((node) => {
    const prompt = readText(node.data.prompt) ?? readText(node.data.sourcePrompt);
    return prompt ? [prompt] : [];
  });
  // Repeated prompt framing stays literal; task-specific differences become editable inputs.
  let prefix = prompts.length > 1 ? prompts[0] : '';
  for (const prompt of prompts.slice(1)) while (!prompt.startsWith(prefix)) prefix = prefix.slice(0, -1);
  if (prefix && !/\s$/.test(prefix)) prefix = prefix.slice(0, prefix.search(/\S+$/));
  const structures = members.map((node) => {
    const alias = aliases.get(node.id)!;
    const data = node.data;
    const parameters: string[] = [];
    for (const field of ['model', 'modelId', 'aspectRatio', 'size', 'resolution', 'duration'] as const) {
      if (typeof data[field] === 'string' || typeof data[field] === 'number') parameters.push(`${field}=${JSON.stringify(data[field])}`);
    }
    const templateLines: string[] = [];
    for (const [field, value] of [['prompt', readText(data.prompt) ?? readText(data.sourcePrompt)], ['content', readText(data.content)]] as const) {
      if (!value) continue;
      const key = `${alias}_${field}`;
      const common = field === 'prompt' && value.startsWith(prefix) ? prefix : '';
      const template = /\{\{[^{}]+\}\}/.test(value) ? value : `${common}{{${key}}}`;
      if (template !== value) defaults.push(`- {{${key}}}: ${JSON.stringify(value.slice(common.length))}`);
      templateLines.push(`  ${field} template: ${template}`);
    }
    const parent = node.parentId ? aliases.get(node.parentId) : undefined;
    return [`- ${alias}: ${node.type} (${resolveNodeDisplayName(node.type!, node.data)})${parent ? `; parent=${parent}` : ''}${parameters.length ? `; ${parameters.join(', ')}` : ''}`, ...templateLines].join('\n');
  });
  const connections = edges.filter((edge) => aliases.has(edge.source) && aliases.has(edge.target))
    .map((edge) => `- ${aliases.get(edge.source)}${edge.sourceHandle ? ` [${edge.sourceHandle}]` : ''} -> ${aliases.get(edge.target)}${edge.targetHandle ? ` [${edge.targetHandle}]` : ''}`);
  const name = resolveNodeDisplayName(group.type!, group.data);
  return {
    name, description: `Reusable ${members.length}-node workflow from ${name}`, surface: 'canvas', tools: ['canvas_command'],
    instructions: [
      `Recreate this workflow for {{task}}. Resolve placeholders with the user before editing; example values below are editable defaults, not fixed requirements.`,
      'Read the current canvas first. Create new nodes using registered types, retain returned ids, then connect them as described. Apply graph edits as one undoable transaction. Never submit paid generation without explicit approval.',
      '## Nodes', ...structures, '## Connections', ...(connections.length ? connections : ['No internal connections.']),
      '## Template defaults', ...defaults,
    ].join('\n\n'),
  };
}
