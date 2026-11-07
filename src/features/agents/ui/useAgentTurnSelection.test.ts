import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { useSettingsStore } from '@/stores/settingsStore';

vi.mock('@/features/canvas/agent/application/canvasAgentController', () => ({ getCanvasAgentSession: vi.fn(() => null) }));

import { resolveAgentTurnSelection } from './useAgentTurnSelection';

function entry(id: string, overrides: Partial<ChatCatalogEntry> = {}): ChatCatalogEntry {
  return {
    id, providerId: 'p', providerLabel: 'Provider', modelId: id, modelLabel: id,
    supportsMultimodal: false, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false,
    supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true, ...overrides,
  };
}

const first = entry('first');
const saved = entry('saved');
const global = entry('global');
const catalog = [first, saved, global];

describe('Agent turn selection', () => {
  beforeEach(() => {
    useSettingsStore.getState().setAgentDefaults({ modelId: 'global', executionMode: 'manual' });
  });

  it('prefers this turn, then the saved conversation, then global defaults for each field', () => {
    const fromDefaults = resolveAgentTurnSelection({ catalog, explicit: {}, session: null });
    expect(fromDefaults).toMatchObject({ model: global, modelSource: 'default', executionMode: 'manual', modeSource: 'default' });

    const fromSession = resolveAgentTurnSelection({ catalog, explicit: {}, session: { modelRef: 'saved', executionMode: 'auto' } });
    expect(fromSession).toMatchObject({ model: saved, modelSource: 'session', executionMode: 'auto', modeSource: 'session' });

    const explicit = resolveAgentTurnSelection({ catalog, explicit: { modelId: 'first', executionMode: 'manual' }, session: { modelRef: 'saved', executionMode: 'auto' } });
    expect(explicit).toMatchObject({ model: first, modelSource: 'selection', executionMode: 'manual', modeSource: 'selection' });

    // A saved conversation without a recorded mode still takes the global mode, not a hardcoded manual.
    useSettingsStore.getState().setAgentDefaults({ executionMode: 'auto' });
    expect(resolveAgentTurnSelection({ catalog, explicit: {}, session: { modelRef: 'saved' } }).executionMode).toBe('auto');
  });

  it('never substitutes the first catalog model for a missing, deleted, unusable or tool-less choice', () => {
    useSettingsStore.getState().setAgentDefaults({ modelId: null });
    expect(resolveAgentTurnSelection({ catalog, explicit: {}, session: null })).toMatchObject({ model: null, modelIssue: 'unset' });
    expect(resolveAgentTurnSelection({ catalog, explicit: {}, session: { modelRef: 'deleted' } })).toMatchObject({ model: null, modelIssue: 'missing' });

    const locked = entry('locked', { usable: false });
    const chatOnly = entry('chat-only', { supportsTools: false });
    const withIssues = [first, locked, chatOnly];
    expect(resolveAgentTurnSelection({ catalog: withIssues, explicit: {}, session: { modelRef: 'locked' } }))
      .toMatchObject({ model: null, requestedModel: locked, modelIssue: 'unavailable' });
    expect(resolveAgentTurnSelection({ catalog: withIssues, explicit: {}, session: { modelRef: 'chat-only' } }))
      .toMatchObject({ model: null, requestedModel: chatOnly, modelIssue: 'no-tools' });
    // Only runnable models are offered as choices.
    expect(resolveAgentTurnSelection({ catalog: withIssues, explicit: {}, session: null }).models).toEqual([first]);
  });
});
