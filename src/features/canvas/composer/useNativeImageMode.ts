import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { automaticImageParameters, imageModeReferenceCount, resolveImageMode } from '@/features/channels/application/imageModeSelection';
import { listModelModes } from '@/features/channels/application/modelModes';
import { isImageEditNode, isStoryboardGenNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
import { useCanvasStore } from '@/stores/canvasStore';
import { useNodeReferences } from './useNodeReferences';

/** The parameter panel and count shortcut must resolve exactly the same mode and defaults. */
export function useNativeImageMode(nodeId: string, value: ModelConfigValue | null) {
  const node = useCanvasStore(state => state.nodes.find(item => item.id === nodeId));
  const data = node && (isImageEditNode(node) || isStoryboardGenNode(node)) ? node.data : undefined;
  const references = useNodeReferences(nodeId);
  const native = value ? resolveNativeChannelModel(value.entryId) : null;
  if (!native || !data || !value) return null;
  const requested = data.channelModeId;
  const slots = data.referenceSlots;
  const count = imageModeReferenceCount(native.model, [
    ...references.all.flatMap(ref => ref.kind === 'image' && ref.imageUrl ? [ref.imageUrl] : []),
    ...(node && isStoryboardGenNode(node) ? ['storyboard-grid-reference'] : []),
  ], slots);
  const modes = listModelModes(native.model);
  let active = modes[0];
  let error = '';
  try { active = resolveImageMode(native.model, count, requested); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return { native, requested, slots, count, modes, active, error, references,
    params: requested === undefined ? automaticImageParameters(active, value.extraParams) : value.extraParams ?? {} };
}
