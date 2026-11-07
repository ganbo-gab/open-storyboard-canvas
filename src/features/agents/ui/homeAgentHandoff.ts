/** One-shot handoff from the home composer's Agent mode to the home Agent session page. */
let pendingMessage: string | null = null;

export function queueHomeAgentMessage(text: string): void {
  pendingMessage = text;
}

/** Take-once: a remount (including StrictMode's double effect) never resends the same message. */
export function takeHomeAgentMessage(): string | null {
  const message = pendingMessage;
  pendingMessage = null;
  return message;
}
