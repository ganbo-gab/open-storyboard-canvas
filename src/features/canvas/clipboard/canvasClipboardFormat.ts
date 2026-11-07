import { z } from 'zod';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';
import type { CanvasClipboardSnapshot } from './clipboardIO';

export const CANVAS_CLIPBOARD_PREFIX = 'Open Storyboard Canvas clipboard v1\n';
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const dimension = z.number().finite().positive();
const nodeSchema = z.object({
  id: z.string().min(1), type: z.enum(CANVAS_NODE_TYPES), position: point,
  data: z.record(z.string(), z.json()), parentId: z.string().optional(),
  width: dimension.optional(), height: dimension.optional(),
  measured: z.object({ width: dimension.optional(), height: dimension.optional() }).optional(),
  style: z.object({ width: dimension.optional(), height: dimension.optional() }).optional(),
  extent: z.literal('parent').optional(), expandParent: z.boolean().optional(),
});
const edgeSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(), targetHandle: z.string().nullable().optional(),
  type: z.string().optional(), data: z.record(z.string(), z.json()).optional(),
});
const envelopeSchema = z.object({ version: z.literal(1), nodes: z.array(nodeSchema).min(1).max(10000), edges: z.array(edgeSchema).max(100000) });
const jsonRecord = z.record(z.string(), z.json());
const nullableText = z.string().nullish();
const strings = z.array(z.string());
const vector = z.looseObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const cameraControl = z.looseObject({ enabled: z.boolean().optional(), camera: z.string().optional(), lens: z.string().optional(),
  focalLength: dimension.optional(), aperture: dimension.optional() });
const commonFields = {
  prompt: z.string().optional(), content: z.string().optional(), rawContent: z.string().optional(),
  displayName: z.string().optional(), label: z.string().optional(), aspectRatio: z.string().optional(),
  sourcePrompt: z.string().optional(), basePrompt: z.string().optional(),
  imageUrl: nullableText, previewImageUrl: nullableText, videoUrl: nullableText, localVideoUrl: nullableText,
  audioUrl: nullableText, localAudioUrl: nullableText, thumbnailUrl: nullableText, sourceImageUrl: nullableText,
  snapshotUrl: nullableText, backgroundImageUrl: nullableText, backgroundPanoramaUrl: nullableText,
  model: z.string().optional(), modelId: nullableText, providerId: nullableText, voiceId: nullableText,
  modelConfig: z.looseObject({ entryId: z.string().optional(), extraParams: jsonRecord.nullish() }).nullish(),
  extraParams: jsonRecord.nullish(), audioGenerationParams: jsonRecord.nullish(),
  cameraControl: cameraControl.nullish(), channelModeId: nullableText,
  referenceSlots: z.record(z.string(), strings).nullish(),
};
const shotSchema = z.looseObject({ id: z.string().min(1), description: z.string() });
const splitFrameSchema = z.looseObject({ id: z.string().min(1), imageUrl: z.string().nullable(),
  previewImageUrl: nullableText, note: z.string().optional(), order: z.number().finite().optional(), aspectRatio: z.string().optional() });
const stageItemSchema = z.looseObject({ id: z.string().min(1), label: z.string(), x: z.number().finite(), y: z.number().finite(), color: z.string(),
  refImageUrl: nullableText, pos3d: vector.optional(), rotation3d: vector.optional(), scale3d: vector.optional(),
  pose: jsonRecord.optional(), bodyControls: jsonRecord.optional() });
const stageImageSchema = z.looseObject({ id: z.string().min(1), url: z.string(), label: z.string(), color: z.string().optional() });
const stageCollections = {
  items: z.array(stageItemSchema).optional(), referenceImages: z.array(stageImageSchema).optional(),
  snapshotHistory: strings.optional(), customActionPresets: strings.optional(), customActionPoses: z.record(z.string(), jsonRecord).optional(),
  motionProject: z.looseObject({ cameraTrack: z.array(jsonRecord).optional(), objectTracks: z.record(z.string(), z.array(jsonRecord)).optional(),
    actionTracks: z.record(z.string(), z.array(jsonRecord)).optional(), customClips: z.array(jsonRecord).optional(), cameraRigs: z.array(jsonRecord).optional() }).optional(),
};
const stageSnapshotSchema = z.looseObject({ ...commonFields, ...stageCollections });
const stageProjectSchema = z.looseObject({ id: z.string().min(1), name: z.string(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  coverUrl: nullableText, snapshot: stageSnapshotSchema });

/** Infer primitive/object shapes from the registry without pinning values or discarding
 * provider-specific extensions. Empty collections get item schemas below where required. */
function defaultShape(value: unknown): z.ZodType {
  if (typeof value === 'string') return z.string();
  if (typeof value === 'number') return z.number().finite();
  if (typeof value === 'boolean') return z.boolean();
  if (Array.isArray(value)) return z.array(z.json());
  const record = jsonRecord.safeParse(value);
  if (record.success) return z.looseObject(Object.fromEntries(Object.entries(record.data).map(([key, child]) => [key, defaultShape(child).optional()])));
  return z.json();
}

function decodeNodeData(type: CanvasNode['type'], raw: Record<string, unknown>): CanvasNode['data'] {
  const defaults = getNodeDefinition(type).createDefaultData();
  const shape: Record<string, z.ZodType> = Object.fromEntries(Object.entries(defaults)
    .filter(([, value]) => value !== undefined).map(([key, value]) => [key, defaultShape(value).optional()]));
  Object.assign(shape, commonFields);
  if (type === CANVAS_NODE_TYPES.storyboardGen || type === CANVAS_NODE_TYPES.storyboardSplit) {
    Object.assign(shape, { gridRows: z.number().finite().int().positive(), gridCols: z.number().finite().int().positive(),
      frames: type === CANVAS_NODE_TYPES.storyboardGen ? z.array(shotSchema) : z.array(splitFrameSchema).transform(frames => frames.map((frame, index) => ({ ...frame, note: frame.note ?? '', order: frame.order ?? index }))) });
  }
  if (type === CANVAS_NODE_TYPES.tagGroup) {
    Object.assign(shape, { memberNodeIds: strings, unresolvedMemberIds: strings.optional(), legacyMemberTagIds: strings.optional(), memberTagIds: strings.optional() });
  }
  if (type === CANVAS_NODE_TYPES.jsonCard) {
    shape.displayFields = z.array(z.looseObject({ path: z.string(), label: z.string(), value: z.string() })).optional();
  }
  if (type === CANVAS_NODE_TYPES.blueprint) Object.assign(shape, stageCollections, { directorStudioProjects: z.array(stageProjectSchema).optional() });
  const data = z.looseObject(shape).safeParse({ ...defaults, ...raw });
  if (!data.success) throw new Error('剪贴板中的节点内容类型不完整或已损坏，请重新复制。');
  return data.data as CanvasNode['data'];
}

/** Plain text works in WebKit, Chromium and external applications, without a hidden clipboard. */
export function encodeCanvasClipboard(snapshot: CanvasClipboardSnapshot): string {
  return CANVAS_CLIPBOARD_PREFIX + JSON.stringify({ version: 1, ...snapshot });
}

export function decodeCanvasClipboard(text: string): CanvasClipboardSnapshot | null {
  if (!text.startsWith(CANVAS_CLIPBOARD_PREFIX)) return null;
  if (text.length > 128 * 1024 * 1024) throw new Error('复制的节点数据过大，请分批复制。');
  const parsed = envelopeSchema.safeParse(JSON.parse(text.slice(CANVAS_CLIPBOARD_PREFIX.length)));
  if (!parsed.success) throw new Error('剪贴板中的画布节点数据不完整或版本不兼容，请重新复制。');
  const ids = new Set(parsed.data.nodes.map(node => node.id));
  if (ids.size !== parsed.data.nodes.length) throw new Error('剪贴板包含重复节点，请重新复制。');
  const parents = new Map(parsed.data.nodes.map(node => [node.id, node.parentId]));
  for (const node of parsed.data.nodes) {
    const visited = new Set([node.id]);
    for (let parent = node.parentId; parent; parent = parents.get(parent)) {
      if (!ids.has(parent) || visited.has(parent)) throw new Error('剪贴板中的节点分组关系无效，请重新复制。');
      visited.add(parent);
    }
  }
  // Node defaults restore fields omitted by older payloads; execution states are cleared by duplication.
  const nodes: CanvasNode[] = parsed.data.nodes.map(node => ({ ...node, data: decodeNodeData(node.type, node.data) }));
  const edges: CanvasEdge[] = parsed.data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges };
}
