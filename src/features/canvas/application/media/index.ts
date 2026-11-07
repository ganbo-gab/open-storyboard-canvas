import { isTauri } from '@tauri-apps/api/core';
import { persistImageBinary } from '@/commands/image';
import { persistAssetBlob, persistAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { useCanvasStore } from '@/stores/canvasStore';
import { getCanvasHistoryAgentTurn, withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';
import { useProjectStore } from '@/stores/projectStore';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeData } from '../../domain/canvasNodes';
import { canvasNodeFactory } from '../canvasServices';
import { processAudioEdit } from './audio';
import { getImageEditCapability, processImageEdit } from './image';
import { readMediaBlob, waitForMediaTask } from './resources';
import { getVideoEditCapability, processVideoEdit } from './video';
import { checkMediaEditAbort, MediaEditError, validateMediaEditOperation, type EditedMedia, type MediaEditCapability, type MediaEditOperation, type MediaEditOptions, type MediaEditResult, type ProcessedMedia } from './types';

export { MediaEditError, validateMediaEditOperation } from './types';
export type { MediaEditOperation, MediaEditCapability, MediaEditErrorCode, MediaEditOptions, MediaEditResult, MediaEditProcessing, EditedMedia, ProcessedMedia } from './types';
export { audioBufferToWav, getAudioSplitSegments } from './audio';
export type { PcmAudio, AudioSegment } from './audio';
export { getTransformedImageDimensions } from './image';

/** Local-codec/persistence seam: browser codecs are not available in a Node test runner. */
export interface MediaEditPlatform {
  process(source: string, operation: MediaEditOperation, options: MediaEditOptions): Promise<ProcessedMedia>;
  persist(output: EditedMedia, signal?: AbortSignal): Promise<string>;
}

/** Decode/transform/encode only: never persists, changes the graph, or mutates the source. */
export async function processMediaEdit(source: string, operation: MediaEditOperation, options: MediaEditOptions = {}): Promise<ProcessedMedia> {
  validateMediaEditOperation(operation);
  checkMediaEditAbort(options.signal);
  if (!source.trim()) throw new MediaEditError('missing-source');
  try {
    switch (operation.kind) {
      case 'image.transform': return await processImageEdit(source, operation, options);
      case 'audio.slice': case 'audio.split': case 'audio.rate': return await processAudioEdit(source, operation, options);
      default: return await processVideoEdit(source, operation, options);
    }
  } catch (cause) {
    checkMediaEditAbort(options.signal);
    if (cause instanceof MediaEditError) throw cause;
    throw new MediaEditError('processing-failed', { cause });
  }
}

async function persistEditedMedia(output: EditedMedia, signal?: AbortSignal): Promise<string> {
  checkMediaEditAbort(signal);
  if (output.kind === 'image' && isTauri()) return await persistImageBinary(new Uint8Array(await output.blob.arrayBuffer()), 'png');
  // Audio already has a durable IndexedDB boundary on desktop and browser; no new native command is needed.
  if (output.kind === 'audio') return await persistAssetBlob(output.blob);
  const url = URL.createObjectURL(output.blob);
  try { return await persistAssetMedia(url, false, output.kind); }
  finally { URL.revokeObjectURL(url); }
}

function sourceForOperation(node: CanvasNode, operation: MediaEditOperation): string {
  const data = node.data;
  let value: unknown;
  switch (operation.kind) {
    case 'image.transform':
      if (node.type !== CANVAS_NODE_TYPES.upload && node.type !== CANVAS_NODE_TYPES.imageEdit && node.type !== CANVAS_NODE_TYPES.exportImage && node.type !== CANVAS_NODE_TYPES.panorama) throw new MediaEditError('wrong-node-kind');
      value = data.imageUrl;
      break;
    case 'audio.slice': case 'audio.split': case 'audio.rate':
      if (node.type !== CANVAS_NODE_TYPES.audio) throw new MediaEditError('wrong-node-kind');
      value = data.localAudioUrl || data.audioUrl;
      break;
    default:
      if (node.type !== CANVAS_NODE_TYPES.video) throw new MediaEditError('wrong-node-kind');
      value = data.localVideoUrl || data.videoUrl;
  }
  if (typeof value !== 'string' || !value.trim()) throw new MediaEditError('missing-source');
  return value;
}

function outputNodeData(output: EditedMedia, source: string, operation: MediaEditOperation): Partial<CanvasNodeData> {
  const provenance = { sourceMediaEdit: operation, sourceMediaRange: output.sourceRange };
  if (output.kind === 'image') {
    if (!output.width || !output.height) throw new MediaEditError('processing-failed');
    return { ...provenance, imageUrl: source, previewImageUrl: null, aspectRatio: `${output.width}:${output.height}` };
  }
  if (output.kind === 'video') return { ...provenance, videoUrl: source, localVideoUrl: source, durationSeconds: output.durationSeconds, aspectRatio: `${output.width ?? 16}:${output.height ?? 9}` };
  return { ...provenance, audioUrl: source, localAudioUrl: source, durationSeconds: output.durationSeconds, sourceAudioMode: operation.kind };
}

export function createNodeMediaEditor(platform: MediaEditPlatform): (nodeId: string, operation: MediaEditOperation, options?: MediaEditOptions) => Promise<MediaEditResult> {
  return async (nodeId, operation, options = {}) => {
    const agentTurnId = getCanvasHistoryAgentTurn();
    validateMediaEditOperation(operation);
    checkMediaEditAbort(options.signal);
    const sourceNode = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    if (!sourceNode) throw new MediaEditError('missing-node');
    const source = sourceForOperation(sourceNode, operation);
    const projectId = useProjectStore.getState().currentProjectId;
    options.onProgress?.(0);
    let processed: ProcessedMedia;
    try { processed = await platform.process(source, operation, { ...options, onProgress: (fraction) => options.onProgress?.(Math.max(0, Math.min(1, fraction)) * 0.9) }); }
    catch (cause) {
      checkMediaEditAbort(options.signal);
      if (cause instanceof MediaEditError) throw cause;
      throw new MediaEditError('processing-failed', { cause });
    }
    checkMediaEditAbort(options.signal);
    if (!processed.outputs.length) throw new MediaEditError('processing-failed');
    const persisted: string[] = [];
    try {
      for (const output of processed.outputs) {
        checkMediaEditAbort(options.signal);
        persisted.push(await platform.persist(output, options.signal));
      }
    } catch (cause) {
      checkMediaEditAbort(options.signal);
      if (cause instanceof MediaEditError) throw cause;
      throw new MediaEditError('persistence-failed', { cause });
    }
    checkMediaEditAbort(options.signal);
    const state = useCanvasStore.getState();
    const currentSource = state.nodes.find((node) => node.id === nodeId);
    if (!currentSource || currentSource.type !== sourceNode.type || sourceForOperation(currentSource, operation) !== source
      || useProjectStore.getState().currentProjectId !== projectId) throw new MediaEditError('stale-source');
    const positions = state.findNodePositions(nodeId, processed.outputs.length, 384, 288);
    const created = processed.outputs.map((output, index) => {
      if (!persisted[index] || persisted[index].startsWith('blob:')) throw new MediaEditError('persistence-failed');
      const type = output.kind === 'image' ? CANVAS_NODE_TYPES.exportImage : output.kind === 'video' ? CANVAS_NODE_TYPES.video : CANVAS_NODE_TYPES.audio;
      return { ...canvasNodeFactory.createNode(type, positions[index], outputNodeData(output, persisted[index], operation)), selected: true };
    });
    const edges = created.map((node) => ({ id: crypto.randomUUID(), source: nodeId, target: node.id, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' }));
    const committed = withCanvasHistoryAgentTurn(agentTurnId, () => state.commitGraphTransaction({ expectedRevision: state.revision, nodes: [...state.nodes.map((node) => node.selected ? { ...node, selected: false } : node), ...created], edges: [...state.edges, ...edges], selectedNodeId: created.length === 1 ? created[0].id : null }));
    if (committed === null) throw new MediaEditError('stale-source');
    const next = useCanvasStore.getState();
    useProjectStore.getState().saveCurrentProject(next.nodes, next.edges, next.currentViewport, next.history);
    options.onProgress?.(1);
    return { nodeIds: created.map((node) => node.id), processing: processed.processing };
  };
}

export const runNodeMediaEdit = createNodeMediaEditor({ process: processMediaEdit, persist: persistEditedMedia });

export async function getMediaEditCapability(kind: MediaEditOperation['kind'], source?: string, options: MediaEditOptions = {}): Promise<MediaEditCapability> {
  if (options.signal?.aborted) return { supported: false, reason: 'aborted' };
  if (kind === 'image.transform') return await getImageEditCapability(source, options);
  if (kind === 'audio.slice' || kind === 'audio.split' || kind === 'audio.rate') {
    if (typeof AudioContext === 'undefined' || (kind === 'audio.rate' && typeof OfflineAudioContext === 'undefined')) return { supported: false, reason: 'no-audio-decoder' };
    if (!source) return { supported: true };
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      await waitForMediaTask(context.decodeAudioData(await waitForMediaTask((await readMediaBlob(source, options.signal, true)).arrayBuffer(), options.signal)), options.signal);
      return { supported: true };
    } catch (cause) { return { supported: false, reason: cause instanceof MediaEditError ? cause.code : 'no-audio-decoder' }; }
    finally { await context?.close().catch(() => undefined); }
  }
  return await getVideoEditCapability(kind, source, options);
}
