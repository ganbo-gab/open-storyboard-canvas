import { z } from 'zod';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { listModelModes, modeParamDefaults, resolveModelMode, resolveModelModeOrFirst, retainModeState, type ResolvedMode } from '@/features/channels/application/modelModes';
import { resolveParamValue } from '@/features/channels/domain/template';
import type { RefSlot } from '@/features/channels/domain/profile';
import { rebaseWorkbenchReferenceTokens, workbenchSlotReferences } from './referenceOrder';
import type { WorkbenchSubmitInput } from '../domain/types';
import { resolveWorkbenchMode, usesAutomaticImageMode } from './workbenchImageMode';

/** Moving a reference into a role changes its position, but not what its existing prompt mention means. */
export function assignWorkbenchReferenceToSlot(input: WorkbenchSubmitInput, specs: readonly RefSlot[], referenceId: string, slotKey: string): WorkbenchSubmitInput {
  const reference = input.references?.find(entry => entry.id === referenceId);
  const slot = specs.find(entry => entry.key === slotKey);
  if (!reference || !slot || reference.kind !== slot.kind) return input;
  const existing = input.referenceSlots?.[slot.key] ?? [];
  if (existing.length >= slot.max) return input;
  const referenceSlots = { ...input.referenceSlots, [slot.key]: [...existing, reference.source] };
  const references = input.references?.filter(entry => entry.id !== referenceId) ?? [];
  const assigned = workbenchSlotReferences([slot], referenceSlots).at(-1);
  if (!assigned) return input;
  const previous = [...workbenchSlotReferences(specs, input.referenceSlots ?? {}), ...(input.references ?? [])];
  const next = [...workbenchSlotReferences(specs, referenceSlots).map(entry => entry.id === assigned.id ? { ...entry, id: referenceId } : entry), ...references];
  return { ...input, referenceSlots, references, prompt: rebaseWorkbenchReferenceTokens(input.prompt, previous, next) };
}

/** Native declarations seed editable state as well as requests; legacy transport defaults never enter it. */
export function withWorkbenchChannelDefaults(input: WorkbenchSubmitInput, switchingMode = false): WorkbenchSubmitInput {
  const native = resolveNativeChannelModel(input.model);
  if (!native) return input;
  const automatic = usesAutomaticImageMode(input, native.model);
  let mode: ResolvedMode;
  try { mode = automatic ? resolveWorkbenchMode(input, native.model) : switchingMode ? resolveModelModeOrFirst(native.model, input.channelModeId) : resolveModelMode(native.model, input.channelModeId); }
  catch { if (automatic) return input; throw new Error('模型模式不存在，请重新选择'); }
  let params = input.config?.extraParams ?? {};
  let referenceSlots = input.referenceSlots;
  let references = input.references;
  // Automatic image modes may use different slot keys. Move incompatible images back to the
  // visible reference list before retaining parameters; never truncate them during a mode change.
  if (automatic && switchingMode && referenceSlots) {
    const declared = listModelModes(native.model).flatMap(entry => entry.slots).filter((slot, index, all) => all.findIndex(other => other.key === slot.key) === index);
    const moved = Object.entries(referenceSlots).filter(([key, sources]) => {
      const slot = mode.slots.find(item => item.key === key);
      return !slot || sources.length > slot.max;
    });
    if (moved.length) {
      const known = moved.filter(([key]) => declared.some(slot => slot.key === key));
      references = [...workbenchSlotReferences(declared, Object.fromEntries(known)), ...(references ?? [])];
      referenceSlots = Object.fromEntries(Object.entries(referenceSlots).filter(([key]) => !known.some(([movedKey]) => movedKey === key)));
    }
  }
  if (switchingMode) {
    const retained = retainModeState(mode, params, referenceSlots ?? {});
    params = Object.fromEntries(Object.entries(retained.params).filter(([key, value]) => {
      const param = mode.params.find((entry) => entry.key === key);
      if (!param) return false;
      const json = z.json().safeParse(value);
      if (!json.success) return false;
      try { resolveParamValue(param, json.data); return true; } catch { return false; }
    }));
    if (referenceSlots !== undefined && !automatic) referenceSlots = retained.slots;
  }
  let prompt = input.prompt;
  if (native.model.modes?.length && references?.some(ref => ref.kind !== 'text')) {
    const slots = { ...referenceSlots };
    const identities = new Map<string, string>();
    const previous = [...workbenchSlotReferences(mode.slots, referenceSlots ?? {}), ...references];
    const remaining = references.filter(ref => {
      if (ref.kind === 'text') return true;
      const compatible = mode.slots.filter(slot => slot.kind === ref.kind);
      // A single image slot is unambiguous. Never guess first/last frame roles.
      if (compatible.length !== 1) return true;
      const slot = compatible[0];
      const existing = slots[slot.key] ?? [];
      if (existing.length >= slot.max) return true;
      slots[slot.key] = [...existing, ref.source];
      identities.set(JSON.stringify([slot.key, ref.source, existing.filter(source => source === ref.source).length]), ref.id);
      return false;
    });
    if (remaining.length !== references.length) {
      prompt = rebaseWorkbenchReferenceTokens(prompt, previous, [...workbenchSlotReferences(mode.slots, slots).map(ref => ({ ...ref, id: identities.get(ref.id) ?? ref.id })), ...remaining]);
      references = remaining;
      referenceSlots = slots;
    }
  }
  return { ...input, references, prompt, ...(native.model.modes ? { channelModeId: automatic ? undefined : mode.mode.id } : {}), referenceSlots,
    config: { ...input.config, extraParams: { ...modeParamDefaults(mode), ...params } } };
}
