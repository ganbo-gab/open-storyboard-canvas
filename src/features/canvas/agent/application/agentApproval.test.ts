import { describe, expect, it } from 'vitest';
import {
  AgentApprovalError,
  AgentApprovalExecutionService,
  InMemoryAgentApprovalStore,
  PersistentAgentApprovalStore,
  assertScopedRead,
  cancelPendingApprovals,
  createApprovalId,
  createApprovalRecord,
  createIdempotencyKey,
  listRecoverableGenerationSubmits,
  recoverUnknownGenerationSubmit,
} from './agentApproval';

const defaultApprovalId = createApprovalId('run', 'canvas_command', 'call');
const requestFingerprint = `sha256:${'a'.repeat(64)}`;

function approvedRecord(overrides: Partial<ReturnType<typeof createApprovalRecord>> = {}) {
  return {
    ...createApprovalRecord({
      id: defaultApprovalId,
      runId: 'run',
      projectId: 'project',
      interruptionId: 'call',
      requestFingerprint,
      impact: { effect: 'canvas-write' as const, title: 'Rename', summary: 'Rename one node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
      baseRevision: 3,
    }),
    status: 'approved' as const,
    ...overrides,
  };
}

describe('agent approval safety', () => {
  it('rejects scope expansion and project changes', () => {
    const scope = { projectId: 'p1', runId: 'r1', purpose: 'inspect selection', resourceKinds: ['nodes'], nodeIds: ['n1'], maxItems: 1, expiresAt: Date.now() + 1000 };
    expect(() => assertScopedRead(scope, { projectId: 'p1', runId: 'r1', purpose: 'inspect selection', resourceKinds: ['nodes'], nodeIds: ['n1'], maxItems: 1 })).not.toThrow();
    expect(() => assertScopedRead(scope, { projectId: 'p1', runId: 'r1', purpose: 'inspect selection', resourceKinds: ['nodes'], nodeIds: ['n1', 'n2'], maxItems: 2 })).toThrow(/超出|扩大/);
    expect(() => assertScopedRead(scope, { projectId: 'p1', runId: 'r2', purpose: 'inspect selection', resourceKinds: ['nodes'], nodeIds: ['n1'], maxItems: 1 })).toThrow(/不一致/);
    expect(() => assertScopedRead(scope, { projectId: 'p1', runId: 'r1', purpose: 'inspect selection', resourceKinds: ['nodes'], maxItems: 1 })).toThrow(/扩大/);
  });

  it('stores one redacted receipt for an idempotency key', () => {
    const store = new InMemoryAgentApprovalStore();
    const key = createIdempotencyKey('run', 'generation.submit', 'call');
    store.putReceipt({ id: 'receipt', executionId: 'exec', approvalId: 'approval', idempotencyKey: key, status: 'succeeded', createdAt: 1, updatedAt: 2, output: { authorization: 'Bearer secret', image: 'data:image/png;base64,AAAA', raw: 'a'.repeat(600), wrapped: `base64:${'b'.repeat(600)}`, file: '/Volumes/Production/shot.png', url: 'https://example.test/render?token=secret-value&api_key=hidden&X-Amz-Signature=signed&size=1' } });
    expect(store.getReceipt(key)?.output).toEqual({ authorization: '[configured]', image: '[redacted-media]', raw: '[redacted-media]', wrapped: '[redacted-media]', file: '[redacted-path]', url: 'https://example.test/render?token=[redacted]&api_key=[redacted]&X-Amz-Signature=[redacted]&size=1' });
  });

  it('creates bounded approvals without persisting serialized model state', () => {
    const record = createApprovalRecord({ id: 'a', runId: 'r', projectId: 'p', interruptionId: 'i', requestFingerprint, impact: { effect: 'read', title: 'Read', summary: 'Read one node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false }, baseRevision: 1, serializedRunState: '{"secret":"x"}' });
    expect(record.status).toBe('awaiting-approval');
    const store = new InMemoryAgentApprovalStore(); store.put(record);
    expect(store.get('a')?.serializedRunState).toBeUndefined();
  });

  it('persists redacted approvals and receipts across store instances', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const first = new PersistentAgentApprovalStore(storage);
    first.put(approvedRecord({ impact: { effect: 'canvas-write', title: 'Rename', summary: '/Users/name/project secret', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false } }));
    first.putReceipt({ id: 'receipt', executionId: 'execution', approvalId: defaultApprovalId, idempotencyKey: createIdempotencyKey('run', 'canvas_command', 'call'), status: 'succeeded', createdAt: 1, updatedAt: 2, output: { apiKey: 'secret', file: '/Users/name/image.png' } });
    const restored = new PersistentAgentApprovalStore(storage);
    expect(restored.get(defaultApprovalId)?.impact.summary).toBe('[redacted-path]');
    expect(restored.getReceipt(createIdempotencyKey('run', 'canvas_command', 'call'))?.output).toEqual({ apiKey: '[configured]', file: '[redacted-path]' });
  });

  it('falls back to memory instead of surfacing localStorage quota as a model failure', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); },
    };
    const store = new PersistentAgentApprovalStore(storage);
    store.put(approvedRecord());
    store.putReceipt({
      id: 'receipt',
      executionId: 'execution',
      approvalId: defaultApprovalId,
      idempotencyKey: createIdempotencyKey('run', 'canvas_command', 'call'),
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      output: { ok: true },
    });

    expect(store.get(defaultApprovalId)?.status).toBe('approved');
    expect(store.getReceipt(createIdempotencyKey('run', 'canvas_command', 'call'))?.output)
      .toEqual({ ok: true });
  });

  it('measures the approval ledger using WebKit UTF-16 quota bytes', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const store = new PersistentAgentApprovalStore(storage, () => 1_000);
    for (let index = 0; index < 80; index += 1) {
      store.put(approvedRecord({
        id: createApprovalId(`run-${index}`, 'canvas_command', `call-${index}`),
        runId: `run-${index}`,
        interruptionId: `call-${index}`,
        status: 'succeeded',
        createdAt: index,
        expiresAt: index + 1,
        impact: {
          effect: 'canvas-write',
          title: 'Rename',
          summary: `已完成操作 ${index} ${'画布记录'.repeat(1_000)}`,
          affectedNodeCount: 1,
          affectedEdgeCount: 0,
          externalSideEffect: false,
        },
      }));
    }

    const serialized = values.get('storyboard-copilot:canvas-agent:approval-ledger:v1') ?? '';
    expect(serialized.length * 2).toBeLessThanOrEqual(512 * 1024);
  });

  it('removes expired approval recovery payloads during hydration', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = new PersistentAgentApprovalStore(storage, () => 10);
    first.putRunRecovery([approvedRecord({
      status: 'awaiting-approval',
      createdAt: 1,
      expiresAt: 20,
    })], {
      runId: 'run',
      projectId: 'project',
      sessionId: 'session',
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      serializedState: JSON.stringify({
        events: Array.from({ length: 1_000 }, (_, index) => `Pending event ${index}`),
      }),
      createdAt: 1,
    });
    const before = values.get('storyboard-copilot:canvas-agent:approval-ledger:v1')?.length ?? 0;

    const restored = new PersistentAgentApprovalStore(storage, () => 21);
    const after = values.get('storyboard-copilot:canvas-agent:approval-ledger:v1')?.length ?? 0;
    expect(restored.get(defaultApprovalId)).toBeUndefined();
    expect(restored.getRunRecovery('run')).toBeUndefined();
    expect(after).toBeLessThan(before);
  });

  it('removes an expired recovery lazily after a running application ages it out', () => {
    let now = 10;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const store = new PersistentAgentApprovalStore(storage, () => now);
    store.putRunRecovery([approvedRecord({
      status: 'awaiting-approval',
      createdAt: 1,
      expiresAt: 20,
    })], {
      runId: 'run',
      projectId: 'project',
      sessionId: 'session',
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      serializedState: JSON.stringify({ currentTurn: [], approvals: ['call'] }),
      createdAt: 1,
    });
    now = 21;

    expect(store.getRunRecovery('run')).toBeUndefined();
    expect(JSON.parse(values.get('storyboard-copilot:canvas-agent:approval-ledger:v1') ?? '{}')
      .runRecoveries).toEqual([]);
  });

  it('persists approvals and a resumable RunState in one recovery write', () => {
    const values = new Map<string, string>();
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { writes += 1; values.set(key, value); },
    };
    const store = new PersistentAgentApprovalStore(storage);
    store.putRunRecovery([approvedRecord({ status: 'awaiting-approval' })], {
      runId: 'run',
      projectId: 'project',
      sessionId: 'session',
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      serializedState: JSON.stringify({ currentTurn: [], approvals: ['call'] }),
      createdAt: 10,
    });

    expect(writes).toBe(1);
    const restored = new PersistentAgentApprovalStore(storage);
    expect(restored.get(defaultApprovalId)?.status).toBe('awaiting-approval');
    expect(restored.getRunRecovery('run')).toMatchObject({
      projectId: 'project',
      sessionId: 'session',
      serializedState: JSON.stringify({ currentTurn: [], approvals: ['call'] }),
    });
  });

  it('refuses sensitive or mismatched approval recovery state', () => {
    const store = new InMemoryAgentApprovalStore();
    const approval = approvedRecord({ status: 'awaiting-approval' });
    expect(() => store.putRunRecovery([approval], {
      runId: 'run',
      projectId: 'project',
      sessionId: 'session',
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      serializedState: JSON.stringify({ apiKey: 'do-not-persist' }),
      createdAt: 10,
    })).toThrow(/Invalid Agent run recovery/);
    expect(() => store.putRunRecovery([approval], {
      runId: 'another-run',
      projectId: 'project',
      sessionId: 'session',
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      serializedState: JSON.stringify({ currentTurn: [] }),
      createdAt: 10,
    })).toThrow(/does not match/);
  });

  it('executes duplicate resumes once and replays the stored result', async () => {
    const store = new InMemoryAgentApprovalStore();
    store.put(approvedRecord());
    const service = new AgentApprovalExecutionService(store, () => 10, () => 'receipt');
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = async () => { calls += 1; await gate; return { ok: true, value: 'done' }; };
    const first = service.executeOnce({ approvalId: defaultApprovalId, runId: 'run', projectId: 'project', toolName: 'canvas_command', callId: 'call', requestFingerprint, currentRevision: 3, execute });
    const second = service.executeOnce({ approvalId: defaultApprovalId, runId: 'run', projectId: 'project', toolName: 'canvas_command', callId: 'call', requestFingerprint, currentRevision: 3, execute });
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left.output).toEqual(right.output);
    await expect(service.executeOnce({ approvalId: defaultApprovalId, runId: 'run', projectId: 'project', toolName: 'canvas_command', callId: 'call', requestFingerprint, currentRevision: 4, execute })).resolves.toMatchObject({ replayed: true });
  });

  it('replays a completed receipt after restart even when revision and expiry changed', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const firstStore = new PersistentAgentApprovalStore(storage);
    firstStore.put(approvedRecord({ createdAt: 1, expiresAt: 20 }));
    let calls = 0;
    let sequence = 0;
    const firstService = new AgentApprovalExecutionService(firstStore, () => 10, () => `receipt-${sequence += 1}`);
    await firstService.executeOnce({
      approvalId: defaultApprovalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'call',
      requestFingerprint,
      currentRevision: 3,
      execute: async () => { calls += 1; return { ok: true, revisionAfter: 4 }; },
    });

    const restoredService = new AgentApprovalExecutionService(new PersistentAgentApprovalStore(storage), () => 30);
    await expect(restoredService.executeOnce({
      approvalId: defaultApprovalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'call',
      requestFingerprint,
      currentRevision: 4,
      execute: async () => { calls += 1; return { ok: true, revisionAfter: 5 }; },
    })).resolves.toMatchObject({ replayed: true, output: { revisionAfter: 4 } });
    expect(calls).toBe(1);
  });

  it('fails closed on revision drift, expiry, and an ambiguous persisted send', async () => {
    const store = new InMemoryAgentApprovalStore();
    store.put(approvedRecord());
    const service = new AgentApprovalExecutionService(store, () => 10);
    await expect(service.executeOnce({ approvalId: defaultApprovalId, runId: 'run', projectId: 'project', toolName: 'canvas_command', callId: 'call', requestFingerprint, currentRevision: 4, execute: async () => 'never' })).rejects.toMatchObject({ code: 'conflict' });

    const expiredApprovalId = createApprovalId('run', 'canvas_command', 'expired-call');
    store.put(approvedRecord({ id: expiredApprovalId, interruptionId: 'expired-call', createdAt: 1, expiresAt: 5 }));
    await expect(service.executeOnce({ approvalId: expiredApprovalId, runId: 'run', projectId: 'project', toolName: 'canvas_command', callId: 'expired-call', requestFingerprint, currentRevision: 3, execute: async () => 'never' })).rejects.toMatchObject({ code: 'expired' });

    const ambiguousApprovalId = createApprovalId('run', 'generation', 'external-call');
    store.put(approvedRecord({ id: ambiguousApprovalId, interruptionId: 'external-call', impact: { effect: 'external-submit', title: 'Generate', summary: 'Submit once', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true } }));
    store.putReceipt({ id: 'sending', executionId: 'execution', approvalId: ambiguousApprovalId, idempotencyKey: createIdempotencyKey('run', 'generation', 'external-call'), status: 'sending', createdAt: 1, updatedAt: 1 });
    await expect(service.executeOnce({ approvalId: ambiguousApprovalId, runId: 'run', projectId: 'project', toolName: 'generation', callId: 'external-call', requestFingerprint, currentRevision: 3, execute: async () => 'never' })).rejects.toEqual(expect.objectContaining<Partial<AgentApprovalError>>({ code: 'unknown-outcome' }));
  });

  it('restores an unknown generation submit and polls status without a second paid submit', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const approvalId = createApprovalId('run', 'canvas_command', 'generation-call');
    const generationFingerprint = `sha256:${'c'.repeat(64)}`;
    const firstStore = new PersistentAgentApprovalStore(storage);
    firstStore.put(approvedRecord({
      id: approvalId,
      interruptionId: 'generation-call',
      requestFingerprint: generationFingerprint,
      impact: {
        effect: 'external-submit',
        title: 'generation.submit',
        summary: 'Submit one paid generation',
        affectedNodeCount: 1,
        affectedEdgeCount: 0,
        externalSideEffect: true,
      },
    }));
    let submitCalls = 0;
    const firstService = new AgentApprovalExecutionService(firstStore, () => 10, () => 'generation-receipt');
    await expect(firstService.executeOnce({
      approvalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'generation-call',
      requestFingerprint: generationFingerprint,
      currentRevision: 3,
      safeRecovery: { kind: 'generation-status', nodeIds: ['node-1'], jobIds: [] },
      execute: async () => {
        submitCalls += 1;
        throw new TypeError('network connection closed after request send');
      },
    })).rejects.toThrow(/network connection closed/);

    const restoredStore = new PersistentAgentApprovalStore(storage);
    const [recovery] = listRecoverableGenerationSubmits(restoredStore, {
      projectId: 'project',
      runId: 'run',
    });
    expect(recovery).toMatchObject({
      receiptId: 'generation-receipt',
      receiptStatus: 'unknown',
      kind: 'generation-status',
      nodeIds: ['node-1'],
      jobIds: [],
    });

    const restoredService = new AgentApprovalExecutionService(restoredStore, () => 20);
    await expect(restoredService.executeOnce({
      approvalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'generation-call',
      requestFingerprint: generationFingerprint,
      currentRevision: 3,
      safeRecovery: { kind: 'generation-status', nodeIds: ['node-1'], jobIds: [] },
      execute: async () => {
        submitCalls += 1;
        return { ok: true };
      },
    })).rejects.toMatchObject({ code: 'unknown-outcome' });

    const commands: string[] = [];
    const polled = await recoverUnknownGenerationSubmit({
      store: restoredStore,
      receiptId: recovery.receiptId,
      projectId: 'project',
      runId: 'run',
      target: { nodeId: 'node-1' },
      now: () => 30,
      executeStatus: async (command) => {
        commands.push(command.type);
        return {
          ok: true,
          commandType: 'generation.status',
          revisionBefore: 3,
          revisionAfter: 3,
          impact: {
            effect: 'read',
            summary: 'status',
            affectedNodeIds: ['node-1'],
            affectedEdgeIds: [],
            creates: { nodes: 0, edges: 0, groups: 0 },
            deletes: { nodes: 0, edges: 0, groups: 0 },
            requiresExternalSideEffect: false,
          },
          output: {
            references: { nodeId: 'node-1', jobId: 'job-1', jobIds: ['job-1'] },
            value: { status: 'running' },
          },
        };
      },
    });

    expect(commands).toEqual(['generation.status']);
    expect(submitCalls).toBe(1);
    expect(polled.receipt).toMatchObject({
      status: 'accepted',
      safeRecovery: { kind: 'generation-status', nodeIds: ['node-1'], jobIds: ['job-1'] },
    });
  });

  it('rejects an approval bound to another project or interruption', async () => {
    const store = new InMemoryAgentApprovalStore();
    store.put(approvedRecord());
    const service = new AgentApprovalExecutionService(store, () => 10);
    await expect(service.executeOnce({
      approvalId: defaultApprovalId,
      runId: 'run',
      projectId: 'other-project',
      toolName: 'canvas_command',
      callId: 'call',
      requestFingerprint,
      currentRevision: 3,
      execute: async () => 'never',
    })).rejects.toMatchObject({ code: 'invalid-binding' });
  });

  it('invalidates changed arguments and active-project drift before receipt replay', async () => {
    const store = new InMemoryAgentApprovalStore();
    store.put(approvedRecord({ status: 'succeeded' }));
    store.putReceipt({
      id: 'receipt',
      executionId: 'execution',
      approvalId: defaultApprovalId,
      idempotencyKey: createIdempotencyKey('run', 'canvas_command', 'call'),
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      output: { ok: true },
    });
    const service = new AgentApprovalExecutionService(store, () => 10);
    await expect(service.executeOnce({
      approvalId: defaultApprovalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'call',
      requestFingerprint: `sha256:${'b'.repeat(64)}`,
      activeProjectId: 'project',
      execute: async () => ({ ok: false }),
    })).rejects.toMatchObject({ code: 'invalid-binding' });

    await expect(service.executeOnce({
      approvalId: defaultApprovalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'canvas_command',
      callId: 'call',
      requestFingerprint,
      activeProjectId: 'other-project',
      execute: async () => ({ ok: false }),
    })).rejects.toMatchObject({ code: 'invalid-binding' });
    expect(store.get(defaultApprovalId)?.status).toBe('conflicted');
  });

  it('marks only pending authority cancelled when a run is aborted', () => {
    const store = new InMemoryAgentApprovalStore();
    store.put(approvedRecord({ status: 'approved' }));
    const completedId = createApprovalId('run', 'diagnostics', 'completed');
    store.put(approvedRecord({ id: completedId, interruptionId: 'completed', status: 'succeeded' }));
    cancelPendingApprovals(store, 'run');
    expect(store.get(defaultApprovalId)?.status).toBe('cancelled');
    expect(store.get(completedId)?.status).toBe('succeeded');
  });

  it('rejects config execution when its approved provider revision changed', async () => {
    const store = new InMemoryAgentApprovalStore();
    const approvalId = createApprovalId('run', 'config_patch', 'config-call');
    store.put(approvedRecord({
      id: approvalId,
      interruptionId: 'config-call',
      impact: { effect: 'config-write', title: 'Config', summary: 'Apply provider patch', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false },
      baseConfigRevision: 'provider-v1-old',
    }));
    let calls = 0;
    const service = new AgentApprovalExecutionService(store, () => 10);
    await expect(service.executeOnce({
      approvalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'config_patch',
      callId: 'config-call',
      requestFingerprint,
      currentConfigRevision: 'provider-v1-new',
      execute: async () => { calls += 1; return { ok: true }; },
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(calls).toBe(0);
  });

  it('records rollback and redacted diff metadata on a successful receipt', async () => {
    const store = new InMemoryAgentApprovalStore();
    const approvalId = createApprovalId('run', 'config_patch', 'config-success');
    store.put(approvedRecord({
      id: approvalId,
      interruptionId: 'config-success',
      impact: { effect: 'config-write', title: 'Config', summary: 'Apply provider patch', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false },
    }));
    const service = new AgentApprovalExecutionService(store, () => 10, () => 'receipt');
    const executed = await service.executeOnce({
      approvalId,
      runId: 'run',
      projectId: 'project',
      toolName: 'config_patch',
      callId: 'config-success',
      requestFingerprint,
      execute: async () => ({
        ok: true,
        rollbackToken: 'rollback-token',
        diff: [{ field: 'baseUrl', before: '/Users/private', after: 'https://example.test' }],
      }),
    });
    expect(executed.receipt).toMatchObject({
      rollbackToken: 'rollback-token',
      safeDiff: { diff: [{ field: 'baseUrl', before: '[redacted-path]', after: 'https://example.test' }] },
    });
  });

  it('drops malformed persisted authority instead of restoring it', () => {
    const values = new Map<string, string>();
    values.set('storyboard-copilot:canvas-agent:approval-ledger:v1', JSON.stringify({
      version: 1,
      approvals: [{ id: 'forged', runId: 'run', projectId: 'project', interruptionId: 'call', status: 'approved' }],
      receipts: [{ id: 'receipt', approvalId: 'forged', status: 'succeeded' }],
    }));
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const restored = new PersistentAgentApprovalStore(storage);
    expect(restored.get('forged')).toBeUndefined();
    expect(restored.getReceipt('missing-key')).toBeUndefined();
  });
});
