import { describe, expect, it } from 'vitest';
import type { AgentApprovalRecord, AgentImpactSummary } from './agentApproval';
import { AgentBudgetLedger } from './agentBudget';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function impact(value?: number, confidence: 'known' | 'range' | 'unknown' = 'known'): AgentImpactSummary {
  return {
    effect: 'external-submit',
    title: 'generation.submit',
    summary: 'Generate image',
    affectedNodeCount: 1,
    affectedEdgeCount: 0,
    estimatedCost: { value, currency: 'credits', confidence },
    externalSideEffect: true,
  };
}

function approval(id: string, cost: number): AgentApprovalRecord {
  return {
    id,
    runId: 'run',
    projectId: 'project',
    interruptionId: id,
    requestFingerprint: `sha256:${'a'.repeat(64)}`,
    status: 'approved',
    impact: impact(cost),
    baseRevision: 1,
    createdAt: 1,
    expiresAt: 100,
  };
}

describe('agent project budget ledger', () => {
  it('blocks a known estimate that exceeds the remaining project budget', () => {
    const ledger = new AgentBudgetLedger(storage(), () => 10);
    ledger.setLimit('project', 5);
    expect(ledger.evaluate('project', impact(6))).toMatchObject({
      allowed: false,
      remaining: 5,
      reason: 'budget-exceeded',
    });
  });

  it('reserves, releases and commits estimates by approval id', () => {
    const backing = storage();
    const ledger = new AgentBudgetLedger(backing, () => 10);
    ledger.setLimit('project', 10);
    expect(ledger.reserve(approval('approval-a', 4)).allowed).toBe(true);
    expect(ledger.evaluate('project', impact(7)).allowed).toBe(false);
    ledger.release('project', 'approval-a');
    expect(ledger.evaluate('project', impact(7)).allowed).toBe(true);
    ledger.reserve(approval('approval-b', 4));
    ledger.commit('project', 'approval-b');
    expect(ledger.get('project')).toMatchObject({ spent: 4, reservations: {} });

    const restored = new AgentBudgetLedger(backing, () => 20);
    expect(restored.get('project').spent).toBe(4);
  });

  it('keeps unknown estimates explicit without inventing a value', () => {
    const ledger = new AgentBudgetLedger(storage());
    ledger.setLimit('project', 1);
    expect(ledger.evaluate('project', impact(undefined, 'unknown'))).toMatchObject({
      allowed: true,
      configured: true,
      unknownCost: true,
      estimatedCost: null,
    });
  });
});
