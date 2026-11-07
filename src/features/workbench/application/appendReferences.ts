import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { resolveModelModeOrFirst } from '@/features/channels/application/modelModes';
import type { WorkbenchDraft, WorkbenchReference } from '../domain/types';
import { rebaseWorkbenchReferenceTokens, workbenchSlotReferences } from './referenceOrder';
import { usesAutomaticImageMode } from './workbenchImageMode';

export class WorkbenchReferenceSlotFullError extends Error {
  constructor(readonly modeLabel: string) { super('workbench.referenceSlotFull'); }
}

/** Every upload, library drop and result reuse fills the same declared input slots. */
export function appendWorkbenchReferences(draft: WorkbenchDraft, additions: readonly WorkbenchReference[]): Partial<WorkbenchDraft> {
  const native = resolveNativeChannelModel(draft.model);
  if (!native?.model.modes?.length) return { references: [...(draft.references ?? []), ...additions] };
  // Resolve after adding the image: the current text-to-image mode may have no image slot.
  if (usesAutomaticImageMode(draft, native.model)) return { references: [...(draft.references ?? []), ...additions] };
  const mode = resolveModelModeOrFirst(native.model, draft.channelModeId);
  const slots = { ...draft.referenceSlots };
  for (const reference of additions) {
    const slot = mode.slots.find((entry) => entry.kind === reference.kind && (slots[entry.key]?.length ?? 0) < entry.max);
    if (!slot) throw new WorkbenchReferenceSlotFullError(mode.mode.label);
    slots[slot.key] = [...(slots[slot.key] ?? []), reference.source];
  }
  return { referenceSlots: slots, prompt: rebaseWorkbenchReferenceTokens(draft.prompt,
    workbenchSlotReferences(mode.slots, draft.referenceSlots ?? {}), workbenchSlotReferences(mode.slots, slots)) };
}
