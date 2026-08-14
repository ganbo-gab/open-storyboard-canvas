import { describe, expect, it } from 'vitest';

import {
  AgentRunStateCompatibilityError,
  AgentSessionRepository,
} from './agentSessionRepository';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('AgentSessionRepository', () => {
  it('round-trips project sessions and SDK history across repository instances', async () => {
    const storage = new MemoryStorage();
    let now = 100;
    const repository = new AgentSessionRepository(storage, () => now++, () => 'session-1');
    const created = repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    const sdkSession = repository.createSdkSession(created.id);
    await sdkSession.addItems([{ role: 'user', content: 'Plan three shots' }]);

    const restored = new AgentSessionRepository(storage).getSession('session-1');
    expect(restored).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      items: [{ role: 'user', content: 'Plan three shots' }],
    });
  });

  it('persists stable media metadata without persisting media bodies', () => {
    const storage = new MemoryStorage();
    const repository = new AgentSessionRepository(storage, () => 100, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    repository.recordMediaReferences('session-1', [{
      referenceId: 'run-1:node-1:image',
      runId: 'run-1',
      assetId: 'node-1:image',
      nodeId: 'node-1',
      title: 'Hero reference',
      origin: 'canvas-asset',
      mimeType: 'image/png',
      createdAt: 100,
    }]);

    const restored = new AgentSessionRepository(storage).getMediaReferences('session-1');
    expect(restored).toEqual([expect.objectContaining({
      referenceId: 'run-1:node-1:image',
      assetId: 'node-1:image',
      nodeId: 'node-1',
    })]);
    expect(JSON.stringify(Array.from(storage.values.values()))).not.toContain('data:image');
    expect(() => repository.recordMediaReferences('session-1', [{
      ...restored[0],
      title: 'x'.repeat(241),
    }])).toThrow(/metadata/i);
  });

  it('keeps idempotent history transactions atomic', async () => {
    const repository = new AgentSessionRepository(null, () => 1, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    const session = repository.createSdkSession('session-1');
    const transaction = {
      operationId: 'op-1',
      transaction: {
        type: 'append_items' as const,
        items: [{ role: 'user' as const, content: 'hello' }],
      },
    };
    await session.applyHistoryTransaction(transaction);
    await session.applyHistoryTransaction(transaction);
    expect(await session.getItems()).toHaveLength(1);
    await expect(session.applyHistoryTransaction({
      operationId: 'op-1',
      transaction: { type: 'append_items', items: [{ role: 'user', content: 'different' }] },
    })).rejects.toThrow('different input');
    expect(await session.getItems()).toHaveLength(1);
  });

  it('stores resumable RunState separately with compatibility versions', () => {
    const storage = new MemoryStorage();
    const repository = new AgentSessionRepository(storage, () => 10, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    repository.saveRunState({
      id: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'awaiting_approval',
      serializedState: JSON.stringify({ approvals: [{ callId: 'call-1' }] }),
    });
    expect(repository.getRunState('run-1')).toMatchObject({
      runtimeVersion: 1,
      agentDefinitionVersion: 1,
      commandSchemaVersion: 1,
      status: 'awaiting_approval',
    });
    expect(repository.getSession('session-1')?.items).toEqual([]);
    expect(repository.getRunStateForResume('run-1').id).toBe('run-1');
  });

  it('stores full state only for resumable runs and compacts terminal payloads', () => {
    const storage = new MemoryStorage();
    const repository = new AgentSessionRepository(storage, () => 10, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    const largeState = JSON.stringify({
      trace: Array.from({ length: 2_000 }, (_, index) => `Agent event ${index}: canvas state checkpoint.`),
    });
    repository.saveRunState({
      id: 'run-complete',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'completed',
      serializedState: largeState,
    });
    repository.saveRunState({
      id: 'run-pending',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'awaiting_approval',
      serializedState: largeState,
    });

    expect(repository.getRunState('run-complete')?.serializedState).toBe('{}');
    expect(repository.getRunState('run-pending')?.serializedState).toBe(largeState);
  });

  it('compacts legacy terminal RunState during repository hydration', () => {
    const storage = new MemoryStorage();
    storage.setItem('storyboard-copilot:canvas-agent:run-states:v1', JSON.stringify({
      version: 1,
      runStates: [{
        id: 'run-old-complete',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'completed',
        runtimeVersion: 1,
        agentDefinitionVersion: 1,
        commandSchemaVersion: 1,
        serializedState: JSON.stringify({
          trace: Array.from({ length: 2_000 }, (_, index) => `Legacy event ${index}: completed run checkpoint.`),
        }),
        createdAt: 1,
        updatedAt: 2,
      }],
    }));

    const repository = new AgentSessionRepository(storage);
    expect(repository.getRunState('run-old-complete')?.serializedState).toBe('{}');
    expect(storage.getItem('storyboard-copilot:canvas-agent:run-states:v1')?.length)
      .toBeLessThan(1_000);
  });

  it('cancels stale resumable RunState during repository hydration', () => {
    const storage = new MemoryStorage();
    storage.setItem('storyboard-copilot:canvas-agent:run-states:v1', JSON.stringify({
      version: 1,
      runStates: [{
        id: 'run-stale',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'awaiting_approval',
        runtimeVersion: 1,
        agentDefinitionVersion: 1,
        commandSchemaVersion: 1,
        serializedState: JSON.stringify({
          events: Array.from({ length: 1_000 }, (_, index) => `Pending event ${index}`),
        }),
        createdAt: 1,
        updatedAt: 2,
      }],
    }));

    const repository = new AgentSessionRepository(storage, () => 30 * 60_000 + 3);
    expect(repository.getRunState('run-stale')).toMatchObject({
      status: 'cancelled',
      serializedState: '{}',
    });
    expect(storage.getItem('storyboard-copilot:canvas-agent:run-states:v1')?.length)
      .toBeLessThan(1_000);
  });

  it('cancels a resumable RunState lazily after a running repository ages it out', () => {
    let now = 10;
    const storage = new MemoryStorage();
    const repository = new AgentSessionRepository(storage, () => now, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    repository.saveRunState({
      id: 'run-live',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'awaiting_approval',
      serializedState: JSON.stringify({
        events: Array.from({ length: 1_000 }, (_, index) => `Pending event ${index}`),
      }),
    });
    now = 30 * 60_000 + 11;

    expect(repository.getRunState('run-live')).toMatchObject({
      status: 'cancelled',
      serializedState: '{}',
    });
  });

  it('keeps the current Agent usable in memory when persistent storage is full', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const repository = new AgentSessionRepository(storage, () => 10, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    await repository.createSdkSession('session-1').addItems([{ role: 'user', content: 'hello' }]);

    expect(repository.getSession('session-1')?.items).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('rejects incompatible RunState versions instead of attempting a blind resume', () => {
    const storage = new MemoryStorage();
    storage.setItem('storyboard-copilot:canvas-agent:sessions:v1', JSON.stringify({
      version: 1,
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        title: 'Session',
        modelRef: 'custom:p:m',
        createdAt: 1,
        updatedAt: 1,
        items: [],
        appliedTransactions: {},
      }],
    }));
    storage.setItem('storyboard-copilot:canvas-agent:run-states:v1', JSON.stringify({
      version: 1,
      runStates: [{
        id: 'run-old',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'awaiting_approval',
        runtimeVersion: 999,
        agentDefinitionVersion: 1,
        commandSchemaVersion: 1,
        serializedState: '{}',
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const repository = new AgentSessionRepository(storage);
    expect(() => repository.getRunStateForResume('run-old'))
      .toThrow(AgentRunStateCompatibilityError);
  });

  it('does not resume cancelled or failed RunState as approval authority', () => {
    const repository = new AgentSessionRepository(null, () => 10, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    for (const status of ['cancelled', 'failed'] as const) {
      repository.saveRunState({
        id: `run-${status}`,
        sessionId: 'session-1',
        projectId: 'project-1',
        status,
        serializedState: '{}',
      });
      expect(() => repository.getRunStateForResume(`run-${status}`))
        .toThrow(AgentRunStateCompatibilityError);
    }
  });

  it('rejects credentials, inline media, base64, and local paths before persistence', () => {
    const repository = new AgentSessionRepository(null, () => 1, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    const unsafeValues = [
      { apiKey: 'secret-value' },
      { image: 'data:image/png;base64,abc' },
      { media: 'blob:https://example.test/id' },
      { path: '/Users/example/private.png' },
      { path: '/Volumes/Production/shot.png' },
      { path: '/private/var/tmp/shot.png' },
      { path: '~/Desktop/shot.png' },
      { path: '\\\\studio-server\\shots\\shot.png' },
      { body: 'a'.repeat(600) },
      { body: `base64:${'b'.repeat(600)}` },
      { url: 'https://example.test/result?api_key=secret-value&X-Amz-Signature=signed-value' },
    ];
    for (const value of unsafeValues) {
      expect(() => repository.replaceItems('session-1', [{
        role: 'user',
        content: JSON.stringify(value),
        providerData: value,
      }])).toThrow('rejected');
    }
    expect(repository.getSession('session-1')?.items).toEqual([]);
  });

  it('deletes a session and all of its paused runs', () => {
    const repository = new AgentSessionRepository(null, () => 1, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    repository.saveRunState({
      id: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'failed',
      serializedState: '{}',
    });
    repository.deleteSession('session-1');
    expect(repository.getSession('session-1')).toBeNull();
    expect(repository.getRunState('run-1')).toBeNull();
  });

  it('compacts history without deleting paused RunState and reports bounded memory', () => {
    const repository = new AgentSessionRepository(null, () => 1, () => 'session-1');
    repository.createSession({ projectId: 'project-1', modelRef: 'custom:p:m' });
    repository.replaceItems('session-1', Array.from({ length: 200 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index}`,
    })));
    repository.saveRunState({
      id: 'run-approval',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'awaiting_approval',
      serializedState: JSON.stringify({ approvals: [{ callId: 'call-1' }] }),
    });

    repository.compactSession('session-1', {
      summary: 'The user planned 200 storyboard messages.',
      replacementItems: [{ role: 'user', content: 'Continue from the compacted summary.' }],
    });
    expect(repository.getSession('session-1')).toMatchObject({
      compactedSummary: 'The user planned 200 storyboard messages.',
      items: [{ role: 'user', content: 'Continue from the compacted summary.' }],
    });
    expect(repository.getRunStateForResume('run-approval').status).toBe('awaiting_approval');
    expect(repository.estimateSessionBytes('session-1')).toBeLessThan(8 * 1024 * 1024);
  });

  it('ignores corrupt or secret-bearing persisted envelopes', () => {
    const storage = new MemoryStorage();
    storage.setItem('storyboard-copilot:canvas-agent:sessions:v1', JSON.stringify({
      version: 1,
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        title: 'Unsafe',
        modelRef: 'custom:p:m',
        createdAt: 1,
        updatedAt: 1,
        items: [{ role: 'user', content: 'hello', providerData: { apiKey: 'secret-value' } }],
        appliedTransactions: {},
      }],
    }));
    expect(new AgentSessionRepository(storage).listSessions('project-1')).toEqual([]);
  });
});
