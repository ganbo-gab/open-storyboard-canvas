export function isCanvasAgentRunCurrent(input: {
  ownerProjectId: string;
  visibleProjectId: string;
  storedProjectId: string | null;
  ownerEpoch: number;
  currentEpoch: number;
}): boolean {
  return input.ownerProjectId === input.visibleProjectId
    && input.ownerProjectId === input.storedProjectId
    && input.ownerEpoch === input.currentEpoch;
}
