import { describe, expect, it } from 'vitest';
import { selectWorkbenchConversations } from './conversationSelectors';
import type { WorkbenchConversation } from '../domain/types';

const conversations: Record<string, WorkbenchConversation> = {
  pinnedA: { id: 'pinnedA', title: 'A', createdAt: 1, updatedAt: 1, pinnedAt: 10, projectId: 'project' },
  pinnedB: { id: 'pinnedB', title: 'B', createdAt: 2, updatedAt: 2, pinnedAt: 10, projectId: null },
  latest: { id: 'latest', title: 'Latest', createdAt: 3, updatedAt: 100, pinnedAt: null, projectId: 'project' },
};

describe('conversation ordering', () => {
  it('keeps equal-time pins stable across new activity and orders unpinned conversations by recent use', () => {
    expect(selectWorkbenchConversations({ conversations }).map((conversation) => conversation.id)).toEqual(['pinnedB', 'pinnedA', 'latest']);
    const updated = { ...conversations, pinnedA: { ...conversations.pinnedA, updatedAt: 1000 } };
    expect(selectWorkbenchConversations({ conversations: updated }).map((conversation) => conversation.id)).toEqual(['pinnedB', 'pinnedA', 'latest']);
    expect(selectWorkbenchConversations({ conversations: updated }, { projectId: 'project' }).map((conversation) => conversation.id)).toEqual(['pinnedA', 'latest']);
    expect(selectWorkbenchConversations({ conversations: updated }, { projectId: null }).map((conversation) => conversation.id)).toEqual(['pinnedB']);
    expect(conversations.pinnedA.updatedAt).toBe(1);
  });
});
