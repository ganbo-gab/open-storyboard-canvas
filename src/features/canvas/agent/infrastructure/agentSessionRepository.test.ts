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
