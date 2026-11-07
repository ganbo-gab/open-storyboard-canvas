import type { WorkbenchConversation, WorkbenchData } from '../domain/types';

export interface WorkbenchConversationQuery {
  projectId?: string | null;
  text?: string;
}

/** Pins keep their order when messages arrive; ties and old timestamps remain deterministic. */
export function selectWorkbenchConversations(state: Pick<WorkbenchData, 'conversations'>, query: WorkbenchConversationQuery = {}): WorkbenchConversation[] {
  const text = query.text?.trim().toLocaleLowerCase();
  return Object.values(state.conversations)
    .filter((conversation) => (query.projectId === undefined || conversation.projectId === query.projectId)
      && (!text || conversation.title.toLocaleLowerCase().includes(text)))
    .sort((a, b) => {
      const pinOrder = Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null);
      if (pinOrder) return pinOrder;
      const activityOrder = a.pinnedAt !== null && b.pinnedAt !== null ? b.pinnedAt - a.pinnedAt : b.updatedAt - a.updatedAt;
      return activityOrder || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}
