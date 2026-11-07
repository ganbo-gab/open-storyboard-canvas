import type { RefSlot } from '@/features/channels/domain/profile';
import type { WorkbenchReference } from '../domain/types';

export const WORKBENCH_REFERENCE_PREFIX = { image: '图', video: '视频', audio: '音频', text: '文本' } as const;
const SHORT_PREFIX = { image: '图', video: '视', audio: '音', text: '文' } as const;

function tokens(references: readonly WorkbenchReference[], short = false): Map<string, string> {
  const counts = { image: 0, video: 0, audio: 0, text: 0 };
  const prefix = short ? SHORT_PREFIX : WORKBENCH_REFERENCE_PREFIX;
  return new Map(references.map((reference) => [reference.id, `@${prefix[reference.kind]}${++counts[reference.kind]}`]));
}

/** Slot identity follows the saved media, not its mutable position in the slot. */
export function workbenchSlotReferences(specs: readonly RefSlot[], slots: Record<string, string[]>): WorkbenchReference[] {
  return specs.flatMap((slot) => {
    const occurrences = new Map<string, number>();
    return (slots[slot.key] ?? []).map((source) => {
      const occurrence = occurrences.get(source) ?? 0;
      occurrences.set(source, occurrence + 1);
      return { id: JSON.stringify([slot.key, source, occurrence]), kind: slot.kind, source, name: slot.label };
    });
  });
}

/** Reordering/removing references must preserve the media each existing mention names. */
export function rebaseWorkbenchReferenceTokens(prompt: string, previous: readonly WorkbenchReference[], next: readonly WorkbenchReference[]): string {
  const after = tokens(next);
  const replacements = new Map([...tokens(previous), ...tokens(previous, true)].map(([id, token]) => [token, after.get(id) ?? '']));
  // Match the entire number. A literal @图12 must never be rewritten as @图1 + 2.
  return prompt.replace(/@(?:图|视频|音频|文本|视|音|文)\d+/g, (token) => replacements.get(token) ?? token);
}
