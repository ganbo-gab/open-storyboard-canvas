import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANVAS_AGENT_PANEL_DEFAULT_WIDTH,
  CANVAS_AGENT_PANEL_MAX_WIDTH,
  CANVAS_AGENT_PANEL_MIN_WIDTH,
  isLegacyInferredAgentFailure,
  migrateCanvasAgentPanelState,
  nextAgentFeedId,
  useCanvasAgentPanelStore,
  type AgentFeedItem,
} from './agentPanelStore';

function message(id: string): AgentFeedItem {
  return { id, kind: 'message', role: 'assistant', text: id, createdAt: 1 };
}

describe('canvas agent panel store', () => {
  beforeEach(() => {
    useCanvasAgentPanelStore.setState({
      isOpen: false,
      projectId: null,
      activeView: 'conversation',
      selectedModelId: null,
      selectedImageModelId: null,
      selectedVideoModelId: null,
      executionMode: 'manual',
      autoModeAcknowledged: false,
      showCompletedTools: false,
      panelWidth: CANVAS_AGENT_PANEL_DEFAULT_WIDTH,
      activeSessionId: null,
      externalSessions: {},
      feed: [],
      unread: 0,
    });
  });

  it('clears project-owned feed state and returns to the conversation when the project changes', () => {
    const first = useCanvasAgentPanelStore.getState();
    first.setProject('project-a');
    first.setActiveView('history');
    first.setActiveSessionId('session-a');
    first.addFeedItem(message('message-a'));

    useCanvasAgentPanelStore.getState().setProject('project-b');

    expect(useCanvasAgentPanelStore.getState()).toMatchObject({
      projectId: 'project-b',
      activeView: 'conversation',
      activeSessionId: null,
      feed: [],
      unread: 0,
    });
  });

  it('marks new feed items read when the panel opens', () => {
    useCanvasAgentPanelStore.getState().addFeedItem(message('message-a'));
    expect(useCanvasAgentPanelStore.getState().unread).toBe(1);
    useCanvasAgentPanelStore.getState().setOpen(true);
    useCanvasAgentPanelStore.getState().addFeedItem(message('message-b'));
    expect(useCanvasAgentPanelStore.getState().unread).toBe(0);
  });

  it('bounds the live feed to the most recent 500 items', () => {
    for (let index = 0; index < 505; index += 1) {
      useCanvasAgentPanelStore.getState().addFeedItem(message(`message-${index}`));
    }
    const { feed } = useCanvasAgentPanelStore.getState();
    expect(feed).toHaveLength(500);
    expect(feed[0].id).toBe('message-5');
    expect(feed[499].id).toBe('message-504');
  });

  it('clamps and resets the persisted desktop panel width', () => {
    useCanvasAgentPanelStore.getState().setPanelWidth(120);
    expect(useCanvasAgentPanelStore.getState().panelWidth).toBe(CANVAS_AGENT_PANEL_MIN_WIDTH);
    useCanvasAgentPanelStore.getState().setPanelWidth(999);
    expect(useCanvasAgentPanelStore.getState().panelWidth).toBe(CANVAS_AGENT_PANEL_MAX_WIDTH);
    useCanvasAgentPanelStore.getState().resetPanelWidth();
    expect(useCanvasAgentPanelStore.getState().panelWidth).toBe(CANVAS_AGENT_PANEL_DEFAULT_WIDTH);
  });

  it('requires a fresh acknowledgement after returning from Auto to Manual', () => {
    useCanvasAgentPanelStore.getState().setExecutionMode('auto');
    expect(useCanvasAgentPanelStore.getState().executionMode).toBe('manual');
    useCanvasAgentPanelStore.getState().acknowledgeAutoMode();
    expect(useCanvasAgentPanelStore.getState()).toMatchObject({ executionMode: 'auto', autoModeAcknowledged: true });
    useCanvasAgentPanelStore.getState().setExecutionMode('manual');
    expect(useCanvasAgentPanelStore.getState()).toMatchObject({ executionMode: 'manual', autoModeAcknowledged: false });
  });

  it('persists the compact completed-tool visibility preference', () => {
    useCanvasAgentPanelStore.getState().setShowCompletedTools(true);
    expect(useCanvasAgentPanelStore.getState().showCompletedTools).toBe(true);
  });

  it('migrates legacy activity/runtime/context data without retaining it', () => {
    const migrated = migrateCanvasAgentPanelState({
      activeView: 'activity',
      selectedRuntimeId: 'codex',
      externalSessions: { secret: true },
      projectContexts: { project: { brief: 'legacy' } },
      panelWidth: 900,
      executionMode: 'auto',
    });
    expect(migrated).toMatchObject({
      activeView: 'conversation',
      panelWidth: CANVAS_AGENT_PANEL_MAX_WIDTH,
      executionMode: 'manual',
      autoModeAcknowledged: false,
    });
    expect(migrated).not.toHaveProperty('selectedRuntimeId');
    expect(migrated).not.toHaveProperty('externalSessions');
    expect(migrated).not.toHaveProperty('projectContexts');
  });

  it('drops persisted inferred provider failures whose model ownership cannot be proven', () => {
    const inferredFailure: AgentFeedItem = {
      id: 'legacy-quota',
      kind: 'status',
      status: 'error',
      text: '当前 Agent 文本模型的账号配额已用尽。此次没有继续调用画布工具；请充值或更换账号。',
      createdAt: 1,
    };
    const rawFailure: AgentFeedItem = {
      id: 'raw-quota',
      kind: 'status',
      status: 'error',
      text: 'The quota has been exceeded.',
      createdAt: 2,
    };

    expect(isLegacyInferredAgentFailure(inferredFailure)).toBe(true);
    expect(isLegacyInferredAgentFailure(rawFailure)).toBe(false);
    expect(migrateCanvasAgentPanelState({ feed: [inferredFailure, rawFailure] }).feed).toEqual([rawFailure]);
  });

  it('creates distinct feed identifiers', () => {
    expect(nextAgentFeedId('feed')).not.toBe(nextAgentFeedId('feed'));
  });
});
