import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore } from './agentApproval';
import { AgentCanvasRollbackStore, rollbackAgentCanvasReceipt } from './agentCanvasRollback';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('receipt-addressable canvas rollback', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      nodes: [],
      edges: [],
      revision: 1,
      history: { past: [], future: [] },
    });
    useProjectStore.setState({
      currentProjectId: 'project',
      saveCurrentProject: vi.fn(),
      waitForProjectPersistence: vi.fn(async () => {}),
    });
  });

  it('undoes exactly one matching graph transaction and persists the restored canvas', async () => {
    const store = new AgentCanvasRollbackStore(memoryStorage(), () => 10, () => 'rollback-token');
    const token = store.begin('project', 'run', 1, 0);
    useCanvasStore.getState().addNode('textAnnotationNode', { x: 1, y: 2 }, { content: 'Agent node' });
    const revisionAfter = useCanvasStore.getState().revision;
    store.complete(token, revisionAfter);
    canvasAgentApprovalStore.put({
      id: 'approval', runId: 'run', projectId: 'project', interruptionId: 'call',
      requestFingerprint: `sha256:${'a'.repeat(64)}`, status: 'succeeded',
      impact: { effect: 'canvas-write', title: 'node.create', summary: 'Create node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
      baseRevision: 1, createdAt: 1, expiresAt: 100,
    });
    canvasAgentApprovalStore.putReceipt({
      id: 'receipt', executionId: 'execution', approvalId: 'approval', idempotencyKey: 'rollback-test',
      status: 'succeeded', createdAt: 1, updatedAt: 2, rollbackToken: token,
    });

    await expect(rollbackAgentCanvasReceipt('receipt', 'project', store)).resolves.toMatchObject({ ok: true });
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useProjectStore.getState().saveCurrentProject).toHaveBeenCalledTimes(1);
    expect(canvasAgentApprovalStore.getReceiptById('receipt')?.rolledBackAt).toBeTypeOf('number');
  });

  it('refuses rollback after a newer canvas revision', async () => {
    const store = new AgentCanvasRollbackStore(memoryStorage(), () => 10, () => 'rollback-conflict');
    const token = store.begin('project', 'run', 1, 0);
    useCanvasStore.getState().addNode('textAnnotationNode', { x: 1, y: 2 }, { content: 'Agent node' });
    store.complete(token, useCanvasStore.getState().revision);
    useCanvasStore.getState().addNode('textAnnotationNode', { x: 3, y: 4 }, { content: 'User node' });
    canvasAgentApprovalStore.put({
      id: 'approval-conflict', runId: 'run', projectId: 'project', interruptionId: 'call-conflict',
      requestFingerprint: `sha256:${'b'.repeat(64)}`, status: 'succeeded',
      impact: { effect: 'canvas-write', title: 'node.create', summary: 'Create node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
      baseRevision: 1, createdAt: 1, expiresAt: 100,
    });
    canvasAgentApprovalStore.putReceipt({
      id: 'receipt-conflict', executionId: 'execution-conflict', approvalId: 'approval-conflict', idempotencyKey: 'rollback-conflict-test',
      status: 'succeeded', createdAt: 1, updatedAt: 2, rollbackToken: token,
    });

    await expect(rollbackAgentCanvasReceipt('receipt-conflict', 'project', store)).resolves.toMatchObject({
      ok: false,
      code: 'revision-conflict',
    });
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });
});
