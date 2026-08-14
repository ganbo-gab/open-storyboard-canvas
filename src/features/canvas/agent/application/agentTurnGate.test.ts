import { describe, expect, it } from 'vitest';
import { acquireCanvasAgentTurn, releaseCanvasAgentTurn, type CanvasAgentTurnGate } from './agentTurnGate';

describe('Canvas Agent turn gate', () => {
  it('rejects a same-tick second start until the active turn releases the gate', () => {
    const gate: CanvasAgentTurnGate = { active: false };

    expect(acquireCanvasAgentTurn(gate)).toBe(true);
    expect(acquireCanvasAgentTurn(gate)).toBe(false);

    releaseCanvasAgentTurn(gate);
    expect(acquireCanvasAgentTurn(gate)).toBe(true);
  });
});
