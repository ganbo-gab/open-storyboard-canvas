import { describe, expect, it, vi } from 'vitest';
import { decideAgentAutoApproval } from './agentAutoApprovalPolicy';
import type { PreparedCanvasAgentApproval } from './canvasAgentController';

vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

function prepared(overrides: Partial<PreparedCanvasAgentApproval['record']> = {}): PreparedCanvasAgentApproval {
  const impact = overrides.impact ?? {
    effect: 'canvas-write' as const,
    title: 'node.rename', summary: 'Rename', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false,
  };
  const record = {
    id: 'approval', runId: 'run', projectId: 'project', interruptionId: 'call', toolName: 'canvas_command',
    arguments: { type: 'node.rename', input: { nodeId: 'node', displayName: 'Shot' } },
    requestFingerprint: `sha256:${'a'.repeat(64)}`, status: 'awaiting-approval' as const,
    impact, baseRevision: 1, createdAt: Date.now(), expiresAt: Date.now() + 10_000,
    ...overrides,
  };
  return { record, view: { id: 'call', toolName: record.toolName!, arguments: record.arguments, summary: impact.summary, impact, expiresAt: record.expiresAt } };
}

describe('built-in Agent auto approval policy', () => {
  it('allows an explicit previewed canvas write', () => {
    expect(decideAgentAutoApproval(prepared()).allowed).toBe(true);
  });

  it('keeps only node deletion behind confirmation', () => {
    expect(decideAgentAutoApproval(prepared({ arguments: { type: 'node.delete', input: { nodeIds: ['node'] } } })).allowed).toBe(false);
    expect(decideAgentAutoApproval(prepared({ toolName: 'config_patch', impact: { effect: 'config-write', title: 'config', summary: 'config', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false } })).allowed).toBe(true);
    expect(decideAgentAutoApproval(prepared({ toolName: 'asset_read', impact: { effect: 'read', title: 'read', summary: 'read', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false } })).allowed).toBe(true);
    expect(decideAgentAutoApproval(prepared({ toolName: 'diagnostics', impact: { effect: 'read', title: 'logs', summary: 'logs', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false } })).allowed).toBe(true);
  });

  it('allows new generation and safe result recovery', () => {
    expect(decideAgentAutoApproval(prepared({
      arguments: { type: 'generation.submit', input: { nodeIds: ['node'] } },
      impact: { effect: 'external-submit', title: 'generation.submit', summary: 'generate', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true, estimatedCost: { confidence: 'unknown' } },
    })).allowed).toBe(true);
    expect(decideAgentAutoApproval(prepared({
      arguments: { type: 'generation.recover', input: { jobId: 'job' } },
      impact: { effect: 'canvas-write', title: 'generation.recover', summary: 'recover', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
    })).allowed).toBe(true);
  });
});
