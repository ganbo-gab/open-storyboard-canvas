import { expect, it } from 'vitest';
import { createAgentRequestFingerprint, createApprovalId, createApprovalRecord, PersistentAgentApprovalStore } from './agentApproval';

it('round-trips selected generation declarations and original execution mode through the approval recovery ledger', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); } };
  const store = new PersistentAgentApprovalStore(storage);
  const record = createApprovalRecord({ id: createApprovalId('recover-context', 'canvas_command', 'call'),
    runId: 'recover-context', projectId: 'project', interruptionId: 'call', requestFingerprint: await createAgentRequestFingerprint('canvas_command', {}), baseRevision: 0,
    impact: { effect: 'canvas-write', title: 'Create node', summary: 'Create one node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false } });
  const recovery = { runId: record.runId, projectId: record.projectId, sessionId: 'session', runtimeVersion: 1,
    agentDefinitionVersion: 1, commandSchemaVersion: 1, serializedState: '{}', createdAt: Date.now(), executionMode: 'manual' as const,
    generationPreferences: { image: { modelId: 'custom:image:gpt-image-2.6', supportedResolutions: ['1024x1536'] } } };
  store.putRunRecovery([record], recovery);
  expect(new PersistentAgentApprovalStore(storage).getRunRecovery(record.runId)).toMatchObject({ executionMode: 'manual',
    generationPreferences: recovery.generationPreferences });
  const unsafe = structuredClone(recovery);
  Object.assign(unsafe.generationPreferences.image, { apiKey: 'UNSAFE_RECOVERY_KEY' });
  expect(() => store.putRunRecovery([record], unsafe)).toThrow('Invalid Agent run recovery record');
  expect([...values.values()].join('')).not.toContain('UNSAFE_RECOVERY_KEY');
});
