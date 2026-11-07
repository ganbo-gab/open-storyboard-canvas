import { z } from 'zod';
import { getProjectRecord, upsertProjectRecord } from '@/commands/projectState';
import { projectFromRecord } from '@/features/assets/application/assetCatalog';
import { applyCanvasGraphCommand } from '@/features/canvas/application/canvasCommandGraph';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import type { GenerationRequestOptions } from '@/features/canvas/application/generation/types';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { createCharacterCanvasCommand } from '@/features/characters/application/characterCanvas';
import type { Character } from '@/features/characters/domain/types';
import { appendCanvasHistory, useCanvasStore } from '@/stores/canvasStore';
import { encodeProject, useProjectStore } from '@/stores/projectStore';
import type { HistoryReuseDraft } from '../history/history';
import { instantiateTemplate, type ToolboxTemplate } from '../toolbox/toolbox';
import { enqueueProjectEdit } from './projectEditQueue';

export interface ProjectLibraryPosition { x: number; y: number }
export interface CanvasHistoryReuseOptions {
  tool?: GenerationRequestOptions['tool'];
  count?: number;
}
interface LibraryGraph { nodes: CanvasNode[]; edges: CanvasEdge[] }
type PrepareGraph = (existing: LibraryGraph, position: ProjectLibraryPosition) => LibraryGraph;

const nodeDataSchema = z.record(z.string(), z.unknown());
const reuseOptionsSchema = z.object({
  count: z.number().int().positive().optional(),
  tool: z.object({
    id: z.string().min(1).refine(value => value.trim().length > 0),
    prompt: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

function assertPosition(position: ProjectLibraryPosition): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Canvas position must be finite');
}

/** Reject non-persistable configuration before committing either an active or a stored graph. */
function assertConfiguration(value: unknown, visiting = new Set<object>()): void {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if ((Array.isArray(value) || (typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))) && !visiting.has(value)) {
    visiting.add(value);
    for (const item of Object.values(value)) assertConfiguration(item, visiting);
    visiting.delete(value);
    return;
  }
  throw new Error('Library configuration must contain finite, persistable data');
}

function assertGraph(graph: LibraryGraph, existing: LibraryGraph = { nodes: [], edges: [] }): void {
  if (!graph.nodes.length) throw new Error('Library graph must contain nodes');
  const types = new Set<string>(Object.values(CANVAS_NODE_TYPES));
  const ids = new Set(existing.nodes.map(node => node.id));
  const imported = new Map<string, CanvasNode>();
  for (const node of graph.nodes) {
    if (!node.id?.trim() || ids.has(node.id) || !types.has(node.type)) throw new Error('Invalid library node');
    nodeDataSchema.parse(node.data);
    assertPosition(node.position);
    assertConfiguration(node);
    ids.add(node.id);
    imported.set(node.id, node);
  }
  for (const node of graph.nodes) {
    const ancestors = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (!ids.has(parentId) || ancestors.has(parentId)) throw new Error('Invalid library node parent');
      ancestors.add(parentId);
      parentId = imported.get(parentId)?.parentId;
    }
  }
  const edgeIds = new Set(existing.edges.map(edge => edge.id));
  for (const edge of graph.edges) {
    if (!edge.id?.trim() || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('Invalid library edge');
    assertConfiguration(edge);
    edgeIds.add(edge.id);
  }
}

function assertReuseOptions(value: unknown): asserts value is CanvasHistoryReuseOptions {
  reuseOptionsSchema.parse(value);
  assertConfiguration(value);
}

/** A persisted input draft only. Consumers initialize controls from it; explicit edits win. */
export function getCanvasHistoryReuseOptions(data: CanvasNodeData): CanvasHistoryReuseOptions | null {
  if (data.historyReuseOptions === undefined) return null;
  try {
    assertReuseOptions(data.historyReuseOptions);
    return structuredClone(data.historyReuseOptions);
  } catch {
    return null;
  }
}

async function insertLibraryGraph(projectId: string, position: ProjectLibraryPosition | undefined, prepare: () => PrepareGraph | Promise<PrepareGraph>): Promise<string[]> {
  if (!projectId.trim()) throw new Error('A target project is required');
  if (position) assertPosition(position);
  const requestedPosition = position ? { ...position } : undefined;
  return await enqueueProjectEdit(projectId, async () => {
    // Resolve assets before taking the final graph snapshot; no await may separate it from commit.
    const createGraph = await prepare();
    await useProjectStore.getState().waitForProjectPersistence(projectId);
    const record = await getProjectRecord(projectId);
    if (!record) throw new Error('目标项目已不存在');
    const project = projectFromRecord(record);
    const active = useProjectStore.getState().currentProjectId === projectId;
    const canvas = useCanvasStore.getState();
    const existing: LibraryGraph = active ? canvas : project;
    const viewport = active ? canvas.currentViewport : project.viewport;
    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) throw new Error('Invalid target project viewport');
    const screen = canvas.canvasViewportSize;
    const placement = requestedPosition ?? {
      x: ((screen.width || 1200) / 2 - viewport.x) / viewport.zoom - 160,
      y: ((screen.height || 800) / 2 - viewport.y) / viewport.zoom - 120,
    };
    assertPosition(placement);
    const graph = createGraph(existing, placement);
    assertGraph(graph, existing);
    const ids = graph.nodes.map(node => node.id);
    const nodes = [...existing.nodes.map(node => node.selected ? { ...node, selected: false } : node), ...graph.nodes.map(node => ({ ...node, selected: true }))];
    const edges = [...existing.edges, ...graph.edges];
    if (active) {
      // A null selection intent preserves a multi-selection; the store derives a single id when appropriate.
      const revision = canvas.commitGraphTransaction({ expectedRevision: canvas.revision, nodes, edges, selectedNodeId: ids.length === 1 ? ids[0] : null });
      if (revision === null) throw new Error('Canvas changed before the library import could be committed');
      const updated = useCanvasStore.getState();
      useProjectStore.getState().saveCurrentProject(updated.nodes, updated.edges, updated.currentViewport, updated.history);
      await useProjectStore.getState().waitForProjectPersistence(projectId);
      return ids;
    }
    const encoded = encodeProject({ ...project, nodes, edges, nodeCount: nodes.length, updatedAt: Date.now(),
      history: appendCanvasHistory(project.history, project, { nodes, edges }) });
    await upsertProjectRecord({ ...record, updatedAt: encoded.updatedAt, nodeCount: encoded.nodeCount,
      nodesJson: JSON.stringify(encoded.nodes), edgesJson: JSON.stringify(encoded.edges),
      historyJson: JSON.stringify(encoded.history), imagePoolJson: JSON.stringify(encoded.imagePool) });
    await useProjectStore.getState().refreshProjects();
    return ids;
  });
}

/** Apply the character's existing executable image-node configuration, never a material replacement. */
export async function applyCharacterToProject(character: Character, projectId: string, position?: ProjectLibraryPosition): Promise<string[]> {
  const snapshot = structuredClone(character);
  return await insertLibraryGraph(projectId, position, async () => {
    const command = await createCharacterCanvasCommand(snapshot);
    return (_existing, placement) => {
      const prepared = applyCanvasGraphCommand({ ...command, input: { ...command.input, position: placement } },
        { nodes: [], edges: [], selectedNodeId: null }, canvasNodeFactory, 'ui');
      if (!prepared.ok) throw new Error(prepared.error.message);
      return prepared.draft;
    };
  });
}

/** Instantiate every template identity through the existing graph remapper. No execution is scheduled. */
export async function applyToolboxTemplateToProject(template: ToolboxTemplate, projectId: string, position?: ProjectLibraryPosition): Promise<string[]> {
  assertGraph(template);
  assertPosition(template.bounds);
  if (!Number.isFinite(template.bounds.width) || template.bounds.width <= 0 || !Number.isFinite(template.bounds.height) || template.bounds.height <= 0) throw new Error('Invalid template bounds');
  const snapshot = structuredClone(template);
  return await insertLibraryGraph(projectId, position, () => (existing, placement) => instantiateTemplate(snapshot, placement, { existingNodes: existing.nodes, existingEdges: existing.edges }));
}
/** Restore original input and ordered reference content, with fresh identities and no job handles. */
export async function reuseCanvasHistoryInProject(draft: Extract<HistoryReuseDraft, { surface: 'canvas' }>, projectId: string, position?: ProjectLibraryPosition): Promise<string[]> {
  assertReuseOptions(draft.options);
  assertConfiguration(draft.data);
  nodeDataSchema.parse(draft.data);
  if (!Object.values(CANVAS_NODE_TYPES).includes(draft.nodeType)) throw new Error('Invalid history draft node');
  for (const reference of draft.references) {
    if (!['image', 'video', 'audio', 'text'].includes(reference.kind) || typeof reference.source !== 'string' || !reference.source.trim()
      || (reference.kind !== 'text' && /^(?:blob:|javascript:)/i.test(reference.source))
      || (reference.name !== undefined && typeof reference.name !== 'string')) throw new Error('Invalid history reference');
  }
  const snapshot = structuredClone(draft);
  return await insertLibraryGraph(projectId, position, () => (_existing, placement) => {
    const data = snapshot.data;
    for (const key of Object.keys(data)) {
      if (key.startsWith('generation') || ['batchId', 'batchIndex', 'batchTotal', 'batchPrimary', 'batchCollapsed', 'resultNodeId', 'resultNodeIds', 'sourceAiNodeId', 'sourceAgentId', 'jobId', 'jobIds', 'taskId', 'workbenchTaskId', 'lastPreparedPayload', 'lastPayloadDiagnostics', 'lastError', 'lastRunInputHash'].includes(key)) delete data[key];
    }
    if ('isGenerating' in data) data.isGenerating = false;
    if ('isStreaming' in data) data.isStreaming = false;
    data.historyReuseOptions = structuredClone(snapshot.options);
    const node = canvasNodeFactory.createNode(snapshot.nodeType, placement, data);
    const references = snapshot.references.map((reference, index) => {
      const type = reference.kind === 'image' ? CANVAS_NODE_TYPES.upload : reference.kind === 'video' ? CANVAS_NODE_TYPES.video
        : reference.kind === 'audio' ? CANVAS_NODE_TYPES.audio : CANVAS_NODE_TYPES.textAnnotation;
      return canvasNodeFactory.createNode(type, { x: placement.x - 400, y: placement.y + index * 240 }, {
        ...(reference.name ? { displayName: reference.name } : {}),
        ...(reference.kind === 'image' ? { imageUrl: reference.source } : {}),
        ...(reference.kind === 'video' ? { videoUrl: reference.source, localVideoUrl: reference.source } : {}),
        ...(reference.kind === 'audio' ? { audioUrl: reference.source, localAudioUrl: reference.source } : {}),
        ...(reference.kind === 'text' ? { content: reference.source } : {}),
      });
    });
    return { nodes: [node, ...references], edges: references.map(reference => ({ id: `e-${reference.id}-${node.id}`, source: reference.id, target: node.id,
      sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' })) };
  });
}
