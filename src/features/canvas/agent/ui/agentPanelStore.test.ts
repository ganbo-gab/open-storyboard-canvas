import { beforeEach, describe, expect, it } from 'vitest';
import { nextAgentFeedId, useCanvasAgentPanelStore, type AgentFeedItem } from './agentPanelStore';

function message(id: string): AgentFeedItem {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    text: id,
    createdAt: 1,
  };
}

describe('canvas agent panel store', () => {
  beforeEach(() => {
    useCanvasAgentPanelStore.setState({
      isOpen: false,
      projectId: null,
      activeView: 'conversation',
      selectedModelId: null,
      activeSessionId: null,
      feed: [],
      projectContexts: {},
      unread: 0,
    });
  });

  it('clears project-owned feed state when the project changes', () => {
    const first = useCanvasAgentPanelStore.getState();
    first.setProject('project-a');
    first.setActiveSessionId('session-a');
    first.addFeedItem(message('message-a'));

    expect(useCanvasAgentPanelStore.getState()).toMatchObject({
      projectId: 'project-a',
      activeSessionId: 'session-a',
      unread: 1,
    });

    useCanvasAgentPanelStore.getState().setProject('project-b');

    expect(useCanvasAgentPanelStore.getState()).toMatchObject({
      projectId: 'project-b',
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

  it('bounds the persisted feed to the most recent 500 items', () => {
    for (let index = 0; index < 505; index += 1) {
      useCanvasAgentPanelStore.getState().addFeedItem(message(`message-${index}`));
    }

    const { feed } = useCanvasAgentPanelStore.getState();
    expect(feed).toHaveLength(500);
    expect(feed[0].id).toBe('message-5');
    expect(feed[499].id).toBe('message-504');
  });

  it('creates distinct feed identifiers', () => {
    expect(nextAgentFeedId('feed')).not.toBe(nextAgentFeedId('feed'));
  });

  it('keeps project briefs and pinned references isolated by project', () => {
    const state = useCanvasAgentPanelStore.getState();
    state.setProjectBrief('project-a', 'Keep the lead character consistent.');
    state.togglePinnedNode('project-a', 'node-a');
    state.setProjectBrief('project-b', 'Use a documentary camera.');

    expect(useCanvasAgentPanelStore.getState().projectContexts).toMatchObject({
      'project-a': {
        brief: 'Keep the lead character consistent.',
        pinnedNodeIds: ['node-a'],
      },
      'project-b': {
        brief: 'Use a documentary camera.',
        pinnedNodeIds: [],
      },
    });

    useCanvasAgentPanelStore.getState().clearProjectContext('project-a');
    expect(useCanvasAgentPanelStore.getState().projectContexts['project-a']).toBeUndefined();
    expect(useCanvasAgentPanelStore.getState().projectContexts['project-b']?.brief).toContain('documentary');
  });
});
