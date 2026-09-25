import { describe, expect, it } from 'vitest';
import { isCanvasAgentRunCurrent } from './agentRunOwnership';

describe('Agent run ownership', () => {
  it('drops callbacks from a previous project or invalidated run', () => {
    const active = {
      ownerProjectId: 'project-a',
      visibleProjectId: 'project-a',
      storedProjectId: 'project-a',
      ownerEpoch: 3,
      currentEpoch: 3,
    };
    expect(isCanvasAgentRunCurrent(active)).toBe(true);
    expect(isCanvasAgentRunCurrent({ ...active, visibleProjectId: 'project-b' })).toBe(false);
    expect(isCanvasAgentRunCurrent({ ...active, storedProjectId: 'project-b' })).toBe(false);
    expect(isCanvasAgentRunCurrent({ ...active, currentEpoch: 4 })).toBe(false);
  });
});
