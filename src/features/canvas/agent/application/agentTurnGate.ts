export interface CanvasAgentTurnGate {
  active: boolean;
}

export function acquireCanvasAgentTurn(gate: CanvasAgentTurnGate): boolean {
  if (gate.active) return false;
  gate.active = true;
  return true;
}

export function releaseCanvasAgentTurn(gate: CanvasAgentTurnGate): void {
  gate.active = false;
}
