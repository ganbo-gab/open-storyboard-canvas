// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import type { ScopedAgentSnapshot } from '../application/scopedAgentSession';
import { useSettingsStore } from '@/stores/settingsStore';
import { saveAsset, type AssetRecord } from '@/features/assets/application/assetCatalog';
import { recordAgentContextRequest, recordAgentContextResponse } from '@/features/canvas/agent/application/agentContextUsage';

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: { snapshot: ScopedAgentSnapshot; catalog: ChatCatalogEntry[]; saved: { modelRef: string; executionMode?: 'manual' | 'auto' } | null } = {
    snapshot: { scope: 'stage', projectId: 'p', status: 'idle', messages: [], toolEvents: [], approvals: [], liveText: '', reasoningSummary: '' },
    catalog: [],
    saved: null,
  };
  const session = {
    getSnapshot: () => state.snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listSessions: () => [],
    loadSession: vi.fn(),
    newSession: vi.fn(),
    send: vi.fn(async () => { state.snapshot = { ...state.snapshot, status: 'running' }; }),
    resolveApproval: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return { state, session };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../application/scopedAgentSession', () => ({ getScopedAgentSession: () => harness.session }));
vi.mock('@/features/canvas/application/chatModelCatalog', () => ({ useChatModelCatalog: () => harness.state.catalog }));
vi.mock('@/features/canvas/agent/application/canvasAgentController', () => ({
  getCanvasAgentSession: (id: string) => (id === 's1' ? harness.state.saved : null),
}));
vi.mock('@/features/assets/application/assetCatalog', () => ({
  saveAsset: vi.fn(),
  getAssetPortableSource: async (source: string) => source,
  getAssetDisplaySource: async (source: string) => source,
}));
vi.mock('./useAgentComposerAssist', () => ({
  useAgentComposerAssist: () => ({
    explicitSkillIds: [], onKeyDown: () => false, sync: () => {}, toggleSkills: () => {}, skillsOpen: false,
    popover: null, chips: null, dialogs: null,
    prepare: async (message: string) => ({ message, media: [] }), markSent: () => {}, reset: () => {},
  }),
  mergeTurnMedia: (left: unknown[], right: unknown[]) => [...left, ...right],
}));

import { ScopedAgentPanel } from './ScopedAgentPanel';

function entry(id: string): ChatCatalogEntry {
  return {
    id, providerId: 'p', providerLabel: 'Provider', modelId: id, modelLabel: id,
    supportsMultimodal: false, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false,
    supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true,
  };
}

let root: Root;
let container: HTMLDivElement;

function render() {
  act(() => { root.render(<ScopedAgentPanel scope="stage" projectId="p" compact />); });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

async function typeAndSend(text: string) {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('missing composer');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { button('canvasAgent.send').click(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  harness.state.catalog = [entry('first'), entry('saved'), entry('global')];
  harness.state.saved = { modelRef: 'saved', executionMode: 'auto' };
  harness.state.snapshot = { scope: 'stage', projectId: 'p', sessionId: 's1', status: 'idle', messages: [], toolEvents: [], approvals: [], liveText: '', reasoningSummary: '' };
  harness.session.send.mockClear();
  vi.mocked(saveAsset).mockReset();
  useSettingsStore.getState().setAgentDefaults({ modelId: 'global', executionMode: 'manual' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

describe('ScopedAgentPanel turn selection', () => {
  it('offers a deliberate continuation after failure and leaves the unsent draft intact', async () => {
    harness.state.snapshot = { ...harness.state.snapshot, status: 'error', error: 'provider failed', sessionId: 's1' };
    render();
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Missing composer');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'unsent idea');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('ui.agent.continueRemaining').click());
    expect(harness.session.send).toHaveBeenCalledWith(expect.objectContaining({ message: 'ui.agent.continuePrompt' }));
    expect(textarea.value).toBe('unsent idea');
  });
  it('shows bounded retry progress without presenting another tool approval', () => {
    harness.state.snapshot = { ...harness.state.snapshot, status: 'running', retry: { attempt: 2, maxRetries: 3, status: 503 } };
    render();
    expect(container.textContent).toContain('ui.agent.retrying');
    expect(container.textContent).not.toContain('ui.agent.continueRemaining');
  });
  it('clears the last model context percentage when choosing another model in the same session', async () => {
    harness.state.catalog = harness.state.catalog.map(model => ({ ...model, contextWindow: 100000 }));
    const id = recordAgentContextRequest({ model: { contextSessionId: 's1', catalogId: 'saved', providerId: 'p', modelId: 'saved', label: 'Saved', usable: true,
      capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: false, reasoningSummary: false, toolSearch: false } },
    tools: [], input: [] }, { messages: [{ role: 'user', content: 'Previous turn' }] });
    recordAgentContextResponse('s1', id, { inputTokens: 12000, outputTokens: 100, totalTokens: 12100 });
    render();
    expect(button('canvasAgent.contextUsage').textContent).toContain('12%');
    act(() => button('canvasAgent.modelMenuTitle: Provider · saved (rework.agent.selection.source.session)').click());
    const first = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.includes('first'));
    if (!first) throw new Error('Missing alternative text model');
    act(() => first.click());
    expect(button('canvasAgent.contextUsage').textContent).not.toContain('12%');
    expect(button('canvasAgent.contextUsage').textContent).toContain('—');
  });
  it('keeps a completed upload in its own draft and sends its registered ID once', async () => {
    harness.state.catalog = harness.state.catalog.map((model) => ({ ...model, supportsMultimodal: true }));
    const saved = Promise.withResolvers<AssetRecord>();
    vi.mocked(saveAsset).mockReturnValue(saved.promise);
    render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('missing upload input');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'reference.png', { type: 'image/png' })] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(saveAsset).toHaveBeenCalledOnce());
    });
    await act(async () => { saved.resolve({ id: 'saved-asset', kind: 'image', name: 'reference.png', source: 'https://assets.example/reference.png', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} }); });
    expect(container.querySelector('.agent-attachment-tile')).not.toBeNull();
    await typeAndSend('describe it');
    expect(harness.session.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ media: [expect.objectContaining({ assetId: 'saved-asset', source: 'https://assets.example/reference.png' })] }));
    expect(container.querySelector('.agent-attachment-tile')).toBeNull();
  });

  it('clears an accepted message even when a later tool continuation fails', async () => {
    const pending = Promise.withResolvers<void>();
    harness.session.send.mockImplementationOnce(() => { harness.state.snapshot = { ...harness.state.snapshot, status: 'running' }; return pending.promise; });
    render();
    const textarea = container.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'build scene'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { button('canvasAgent.send').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(textarea.value).toBe('');
    await act(async () => { pending.reject(new Error('tool continuation failed')); });
    expect(textarea.value).toBe('');
    expect(container.textContent).toContain('tool continuation failed');
  });

  it('does not duplicate an in-flight file import or append its late asset to a different project', async () => {
    const saved = Promise.withResolvers<AssetRecord>();
    vi.mocked(saveAsset).mockReturnValue(saved.promise);
    render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('missing upload input');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'late.png', { type: 'image/png' })] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(saveAsset).toHaveBeenCalledOnce());
    });
    expect(button('rework.conversation').disabled).toBe(true);
    act(() => root.render(<ScopedAgentPanel scope="stage" projectId="other-project" compact />));
    await act(async () => saved.resolve({ id: 'late-asset', kind: 'image', name: 'late.png', source: 'https://assets.example/late.png', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} }));
    expect(container.querySelector('.agent-attachment-tile')).toBeNull();
    expect(saveAsset).toHaveBeenCalledOnce();
    expect(button('rework.conversation').disabled).toBe(false);
  });

  it('sends with the saved conversation model and mode instead of the first model or a hardcoded manual mode', async () => {
    render();
    await typeAndSend('frame the alley');
    expect(harness.session.send).toHaveBeenCalledTimes(1);
    expect(harness.session.send).toHaveBeenCalledWith(expect.objectContaining({
      message: 'frame the alley',
      model: expect.objectContaining({ id: 'saved' }),
      executionMode: 'auto',
    }));
  });

  it('uses global defaults for a new conversation', async () => {
    harness.state.snapshot = { ...harness.state.snapshot, sessionId: undefined };
    render();
    await typeAndSend('new idea');
    expect(harness.session.send).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'global' }),
      executionMode: 'manual',
    }));
  });

  it('asks for a choice instead of switching channels when the saved model was deleted', async () => {
    harness.state.saved = { modelRef: 'deleted', executionMode: 'manual' };
    render();
    expect(container.textContent).toContain('rework.agent.selection.issue.missing');
    await typeAndSend('still send?');
    expect(button('canvasAgent.send').disabled).toBe(true);
    expect(harness.session.send).not.toHaveBeenCalled();
  });

  it('keeps pending approvals undecidable without a runnable model and explains why', () => {
    harness.state.saved = { modelRef: 'deleted' };
    harness.state.snapshot = {
      ...harness.state.snapshot,
      status: 'awaiting-approval',
      runId: 'run',
      approvals: [{
        id: 'approval', toolName: 'stage_command', arguments: {}, summary: 'Move camera', expiresAt: Date.now() + 60_000,
        impact: { effect: 'canvas-write', title: 'stage:stage_command', summary: 'Move camera', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false },
      }],
    };
    render();
    expect(container.textContent).toContain('rework.agent.selection.approvalNeedsModel');
    expect(button('canvasAgent.approve').disabled).toBe(true);
    // A waiting turn still offers stop, which revokes the pending approval.
    expect(button('canvasAgent.cancel').disabled).toBe(false);
  });
});
