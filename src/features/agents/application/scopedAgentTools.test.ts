import { describe, expect, it } from 'vitest';
import { AgentSessionRepository } from '@/features/canvas/agent/infrastructure/agentSessionRepository';
import { prepareCanvasAgentToolApproval } from '@/features/canvas/agent/application/canvasAgentController';
import { decideAgentAutoApproval } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import { getScopedAgentTools, inspectScopedAgentTool } from './scopedAgentTools';
import { strictScopedToolSchema, decodeScopedToolInput } from './scopedAgentSchemas';
import { z } from 'zod';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { isRegisteredAgentToolName } from '../domain/agentToolNames';

describe('scoped Agent authority', () => {
  it('persists independent scope identities and treats legacy sessions as canvas', () => {
    let sequence = 0;
    const repository = new AgentSessionRepository(null, () => 1000, () => `session-${++sequence}`);
    const home = repository.createSession({ projectId: 'p', modelRef: 'm', scope: 'home' });
    const canvas = repository.createSession({ projectId: 'p', modelRef: 'm' });
    const stage = repository.createSession({ projectId: 'p', modelRef: 'm', scope: 'stage' });
    expect(new Set([home.id, canvas.id, stage.id]).size).toBe(3);
    expect(repository.listSessions('p', 'home').map((session) => session.id)).toEqual([home.id]);
    expect(repository.listSessions('p', 'stage').map((session) => session.id)).toEqual([stage.id]);
    expect(repository.listSessions('p', 'canvas').map((session) => session.id)).toEqual([canvas.id]);
  });
  it.each(['home', 'canvas', 'stage'] as const)('registers knowledge authority and approval risks in %s', async (scope) => {
    const expected = { kb_search: 'read', kb_read: 'read', kb_write: 'destructive', kb_organize: 'paid' };
    for (const [name, risk] of Object.entries(expected)) {
      const args = name === 'kb_search' ? {} : name === 'kb_write' ? { path: 'A.md', content: '# A' } : name === 'kb_organize' ? { kind: 'tag', paths: ['A.md'] } : { path: 'A.md', offset: 6000, limit: 1000 };
      expect(inspectScopedAgentTool(scope, name, args).risk).toBe(risk);
      const approval = await prepareCanvasAgentToolApproval({ projectId: 'p', runId: `kb-${scope}-${name}`, scope, callId: name, toolName: name, arguments: args, persist: false });
      expect(approval.record.impact.title).toBe(`${scope}: ${name}`);
      expect(decideAgentAutoApproval(approval).allowed).toBe(risk === 'read');
      expect(approval.record.impact.externalSideEffect).toBe(risk === 'paid');
    }
  });
  it('exposes only home channel tools and keeps profile writes manual even in auto mode', async () => {
    const names = ['channel_list', 'channel_models', 'channel_preview', 'channel_generate_profile', 'channel_create', 'channel_update'];
    for (const name of names) {
      expect(getScopedAgentTools('home').map((tool) => tool.name)).toContain(name);
      for (const scope of ['canvas', 'stage'] as const) expect(getScopedAgentTools(scope).some((tool) => tool.name === name)).toBe(false);
    }
    expect(inspectScopedAgentTool('home', 'channel_generate_profile', { docsText: 'Documented API' }).risk).toBe('paid');
    for (const name of ['channel_create', 'channel_update']) {
      const args = { profileJson: '{}', ...(name === 'channel_update' ? { channelId: 'c' } : {}) };
      expect(inspectScopedAgentTool('home', name, args).risk).toBe('edit');
      const approval = await prepareCanvasAgentToolApproval({ projectId: 'home', runId: name, scope: 'home', callId: name, toolName: name, arguments: args, persist: false });
      expect(decideAgentAutoApproval(approval).allowed).toBe(false);
    }
  });
  it('keeps lightweight skill name validation aligned with every public tool', () => {
    for (const scope of ['home', 'canvas', 'stage'] as const) for (const tool of getScopedAgentTools(scope)) expect(isRegisteredAgentToolName(tool.name)).toBe(true);
    expect(isRegisteredAgentToolName('constructor')).toBe(false);
    expect(isRegisteredAgentToolName('invented_tool')).toBe(false);
  });
  it('rejects a selected-skill denial before creating a valid scoped approval', async () => {
    await expect(prepareCanvasAgentToolApproval({ runId: 'denied-kb', projectId: 'p', scope: 'canvas', callId: 'read', toolName: 'kb_read', arguments: { path: 'A.md' }, allowedToolNames: [] })).rejects.toThrow(/not allowed/);
  });

  it('blocks wrong-scope and malformed tools before creating approvals', async () => {
    expect(() => inspectScopedAgentTool('home', 'stage_command', {})).toThrow(/not available/);
    expect(() => inspectScopedAgentTool('stage', 'project_create', { name: 'x' })).toThrow(/not available/);
    expect(() => inspectScopedAgentTool('home', 'project_create', { name: 'x', shell: 'rm' })).toThrow(/Invalid/);
    await expect(prepareCanvasAgentToolApproval({ runId: 'scope-invalid', projectId: 'p', scope: 'home', callId: 'c', toolName: 'canvas_command', arguments: { type: 'node.delete', input: { nodeIds: ['n'] } } })).rejects.toThrow(/not available/);
    await expect(prepareCanvasAgentToolApproval({ runId: 'scope-invalid', projectId: 'p', scope: 'stage', callId: 'd', toolName: 'stage_command', arguments: { nodeId: 'n', command: { type: 'object.remove', itemId: 'i', unexpected: true } } })).rejects.toThrow(/Invalid/);
  });

  it('accepts a stage command batch after strict-schema null decoding', () => {
    expect(() => inspectScopedAgentTool('stage', 'stage_command', {
      nodeId: 'stage',
      command: [
        { type: 'object.update', itemId: 'person', patch: { label: null, note: null } },
        { type: 'object.remove', itemId: 'old-object' },
      ],
    })).not.toThrow();
  });

  it('keeps paid home submissions and stage deletion pending in auto mode', async () => {
    const paid = await prepareCanvasAgentToolApproval({ runId: 'home-paid', projectId: 'home', scope: 'home', callId: 'paid', toolName: 'home_generation_submit', arguments: { kind: 'image', prompt: 'cat', model: 'real-model', config: { size: null, aspectRatio: '16:9', seconds: null } }, persist: false });
    expect(paid.record.impact.effect).toBe('external-submit');
    expect(paid.record.impact.model).toBe('real-model');
    expect(decideAgentAutoApproval(paid).allowed).toBe(false);
    const removal = await prepareCanvasAgentToolApproval({ runId: 'stage-remove', projectId: 'p', scope: 'stage', callId: 'remove', toolName: 'stage_command', arguments: { nodeId: 'stage', command: { type: 'object.remove', itemId: 'person' } }, persist: false });
    expect(decideAgentAutoApproval(removal).allowed).toBe(false);
    const edit = await prepareCanvasAgentToolApproval({ runId: 'home-edit', projectId: 'home', scope: 'home', callId: 'create', toolName: 'project_create', arguments: { name: 'A real project' }, persist: false });
    expect(decideAgentAutoApproval(edit).allowed).toBe(true);
  });

  it('accepts explicit mode/slot requests in the paid home tool and rejects malformed slot sources', () => {
    const input = { kind: 'video', prompt: 'Frames', model: 'custom:channel:model',
      config: { size: null, aspectRatio: null, seconds: null }, modeId: 'frames', referenceSlots: { first_frame: ['/first.png'], last_frame: ['/last.png'] } };
    expect(() => inspectScopedAgentTool('home', 'home_generation_submit', input)).not.toThrow();
    expect(() => inspectScopedAgentTool('home', 'home_generation_submit', { ...input, referenceSlots: { first_frame: [5] } })).toThrow(/Invalid/);
  });

  it('publishes closed strict schemas and decodes optional-null fields without dropping explicit nulls', () => {
    const schema = z.toJSONSchema(z.object({ required: z.string(), optional: z.string().optional(), nullable: z.string().nullable(),
      clearable: z.string().nullable().optional(), nested: z.object({ x: z.number().optional(), clearable: z.enum(['on', 'off']).nullable().optional() }).strict() }).strict());
    const strict = strictScopedToolSchema(schema);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['required', 'optional', 'nullable', 'clearable', 'nested']);
    expect(decodeScopedToolInput(schema, { required: 'yes', optional: null, nullable: null, clearable: null, nested: { x: null, clearable: null } }))
      .toEqual({ required: 'yes', nullable: null, clearable: null, nested: { clearable: null } });
    expect(getScopedAgentTools('stage').map((tool) => tool.name)).toContain('stage_capture');
    expect(getScopedAgentTools('home').map((tool) => tool.name)).not.toContain('stage_command');
  });
});

it('lists only declared channel audio models for the home Agent with their actual modes', async () => {
  const previous = useChannelStore.getState().channels;
  try {
    useChannelStore.setState({ channels: [{ origin: 'native', createdAt: 1, updatedAt: 1, migrationIssues: [], profile: {
      version: 2, id: 'agent-voice', name: 'Voice channel', baseUrl: 'https://voice.invalid', auth: { type: 'none' }, operations: {}, models: [
        { id: 'voice', operations: [], params: [], modes: [{ id: 'speak', label: 'Speak', operation: 'audio.generate', slots: [] }] },
        { id: 'image', operations: ['image.generate'], params: [] },
      ],
    } }] });
    const tool = getScopedAgentTools('home').find((entry) => entry.name === 'generation_models');
    expect(await tool?.execute({ kind: 'audio' }, { projectId: 'home', runId: 'read' })).toEqual([
      expect.objectContaining({ id: 'custom:channel-agent-voice-audio:voice', label: 'voice', provider: 'Voice channel', usable: true, modes: [expect.objectContaining({ id: 'speak' })] }),
    ]);
  } finally { useChannelStore.setState({ channels: previous }); }
});
