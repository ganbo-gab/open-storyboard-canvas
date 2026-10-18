import { describe, expect, it } from 'vitest';
import { AgentSessionRepository } from '@/features/canvas/agent/infrastructure/agentSessionRepository';
import { prepareCanvasAgentToolApproval } from '@/features/canvas/agent/application/canvasAgentController';
import { decideAgentAutoApproval } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import { getScopedAgentTools, inspectScopedAgentTool } from './scopedAgentTools';
import { strictScopedToolSchema, decodeScopedToolInput } from './scopedAgentSchemas';
import { z } from 'zod';

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

  it('blocks wrong-scope and malformed tools before creating approvals', async () => {
    expect(() => inspectScopedAgentTool('home', 'stage_command', {})).toThrow(/not available/);
    expect(() => inspectScopedAgentTool('stage', 'project_create', { name: 'x' })).toThrow(/not available/);
    expect(() => inspectScopedAgentTool('home', 'project_create', { name: 'x', shell: 'rm' })).toThrow(/Invalid/);
    await expect(prepareCanvasAgentToolApproval({ runId: 'scope-invalid', projectId: 'p', scope: 'home', callId: 'c', toolName: 'canvas_command', arguments: { type: 'node.delete', input: { nodeIds: ['n'] } } })).rejects.toThrow(/not available/);
    await expect(prepareCanvasAgentToolApproval({ runId: 'scope-invalid', projectId: 'p', scope: 'stage', callId: 'd', toolName: 'stage_command', arguments: { nodeId: 'n', command: { type: 'object.remove', itemId: 'i', unexpected: true } } })).rejects.toThrow(/Invalid/);
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

  it('publishes closed strict schemas and decodes optional-null fields without dropping explicit nulls', () => {
    const schema = z.toJSONSchema(z.object({ required: z.string(), optional: z.string().optional(), nullable: z.string().nullable(), nested: z.object({ x: z.number().optional() }).strict() }).strict());
    const strict = strictScopedToolSchema(schema);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['required', 'optional', 'nullable', 'nested']);
    expect(decodeScopedToolInput(schema, { required: 'yes', optional: null, nullable: null, nested: { x: null } })).toEqual({ required: 'yes', nullable: null, nested: {} });
    expect(getScopedAgentTools('stage').map((tool) => tool.name)).toContain('stage_capture');
    expect(getScopedAgentTools('home').map((tool) => tool.name)).not.toContain('stage_command');
  });
});
