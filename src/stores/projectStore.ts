import { create } from 'zustand';
import { flushPendingCanvasViewport, isCanvasViewportInteractionActive } from '@/features/canvas/application/canvasViewportCommit';
import { v4 as uuidv4 } from 'uuid';
import type { Viewport } from '@xyflow/react';
import {
  useCanvasStore,
  normalizeCanvasGraph,
  type CanvasEdge,
  type CanvasHistoryState,
  type CanvasNode,
  type CanvasNodeData,
} from './canvasStore';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
} from '@/features/canvas/domain/canvasNodes';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { migrateCanvasNodeMedia, type ProjectMediaResolver, type ProjectMediaResolution } from '@/features/canvas/domain/projectMedia';
import { listAssets, saveAsset, type AssetRecord } from '@/features/assets/application/assetCatalog';
import {
  deleteProjectRecord,
  getProjectRecord,
  listProjectSummaries,
  renameProjectRecord,
  updateProjectViewportRecord,
  upsertProjectRecord,
  type ProjectRecord,
  type ProjectSummaryRecord,
} from '@/commands/projectState';
import {
  appendCanvasHistory,
  applyCanvasHistoryEntry,
  type CanvasGraph,
  mapCanvasHistoryValues,
  MAX_HISTORY_BYTES,
  MAX_PERSISTED_HISTORY_STEPS,
  normalizeCanvasHistory,
  trimCanvasHistory,
} from './canvasHistory';

const DEFAULT_VIEWPORT: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

function createEmptyHistory(): CanvasHistoryState {
  return {
    past: [],
    future: [],
  };
}

const IMAGE_REF_PREFIX = '__img_ref__:';
const HISTORY_MEDIA_FIELDS: Record<string, true | undefined> = {
  imageUrl: true, previewImageUrl: true, thumbnailUrl: true, sourceImageUrl: true,
  snapshotUrl: true, backgroundImageUrl: true, backgroundPanoramaUrl: true,
  videoUrl: true, localVideoUrl: true, audioUrl: true, localAudioUrl: true,
  refImageUrl: true, coverUrl: true, url: true,
};
let openProjectRequestSeq = 0;
const UPSERT_DEBOUNCE_MS = 260;
const VIEWPORT_UPSERT_DEBOUNCE_MS = 280;
const VIEWPORT_EPSILON = 0.001;
const IDLE_PERSIST_TIMEOUT_MS = 1200;
const FALLBACK_IDLE_DELAY_MS = 64;
const INTERACTION_PERSIST_RECHECK_MS = 80;
const MAX_INTERACTION_PERSIST_DELAY_MS = 5_000;
const DELETE_RETRY_DELAY_MS = 80;
const MAX_DELETE_RETRIES = 10;

interface QueuedProjectUpsert {
  project: Project;
  queuedAt: number;
  cancelIdle?: () => void;
  /** True if this entry was queued via `persistProject(immediate=true)`.
   *  Carried through the queue so that when settle re-flushes the queue
   *  after a prior in-flight upsert finishes, the close-time data still
   *  bypasses the requestIdleCallback delay. Without this flag, close-time
   *  edits could sit in the idle queue for up to 1.2s — long enough for
   *  the user to reopen the project and read pre-edit data. */
  immediate: boolean;
}

const queuedProjectUpserts = new Map<string, QueuedProjectUpsert>();
const projectUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectUpsertsInFlight = new Set<string>();
const projectUpsertFailures = new Map<string, unknown>();
const queuedViewportUpserts = new Map<string, string>();
const viewportUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
const viewportUpsertsInFlight = new Set<string>();
const deletingProjectIds = new Set<string>();

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface Project extends ProjectSummary {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  history: CanvasHistoryState;
}

export interface PromptCanvasSeed {
  title: string;
  prompt: string;
}

export type PromptCanvasTarget =
  | { kind: 'existing'; projectId: string }
  | { kind: 'new'; name: string };

type PersistedProject = Omit<Project, 'history'> & {
  history: unknown;
  imagePool?: string[];
};

function encodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[],
  imageIndexMap: Map<string, number>
): string | null | undefined {
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    return imageUrl;
  }

  const existingIndex = imageIndexMap.get(imageUrl);
  if (typeof existingIndex === 'number') {
    return `${IMAGE_REF_PREFIX}${existingIndex}`;
  }

  const nextIndex = imagePool.length;
  imagePool.push(imageUrl);
  imageIndexMap.set(imageUrl, nextIndex);
  return `${IMAGE_REF_PREFIX}${nextIndex}`;
}

function decodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[] | undefined
): string | null | undefined {
  if (typeof imageUrl !== 'string' || !imagePool || !imageUrl.startsWith(IMAGE_REF_PREFIX)) {
    return imageUrl;
  }

  const rawIndex = imageUrl.slice(IMAGE_REF_PREFIX.length);
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
  // Keep unresolved references as evidence; media migration adds a typed missing marker.
  return Number.isSafeInteger(index) && index >= 0 ? imagePool[index] ?? imageUrl : imageUrl;
}

function mapNodeImageReferences(
  nodes: CanvasNode[],
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasNode[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const mapBlueprintItems = (items: unknown): unknown => {
    if (!Array.isArray(items)) return items;
    return items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const rec = item as Record<string, unknown>;
      if (!('refImageUrl' in rec)) return item;
      return {
        ...rec,
        refImageUrl: mapImageUrl(rec.refImageUrl as string | null | undefined) ?? null,
      };
    });
  };

  const mapBlueprintReferenceImages = (images: unknown): unknown => {
    if (!Array.isArray(images)) return images;
    return images.map((image) => {
      if (!image || typeof image !== 'object') return image;
      const rec = image as Record<string, unknown>;
      if (!('url' in rec)) return image;
      return {
        ...rec,
        url: mapImageUrl(rec.url as string | null | undefined) ?? null,
      };
    });
  };

  const mapImageUrlList = (urls: unknown): unknown => {
    if (!Array.isArray(urls)) return urls;
    return urls
      .map((url) => typeof url === 'string' ? mapImageUrl(url) : url)
      .filter((url): url is string => typeof url === 'string' && url.length > 0);
  };

  const mapDirectorProjectSnapshot = (snapshot: unknown): unknown => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const snapshotRecord: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
    for (const key of ['snapshotUrl', 'backgroundImageUrl', 'backgroundPanoramaUrl']) {
      if (key in snapshotRecord) {
        snapshotRecord[key] = mapImageUrl(snapshotRecord[key] as string | null | undefined) ?? null;
      }
    }
    if ('snapshotHistory' in snapshotRecord) {
      snapshotRecord.snapshotHistory = mapImageUrlList(snapshotRecord.snapshotHistory);
    }
    snapshotRecord.items = mapBlueprintItems(snapshotRecord.items);
    snapshotRecord.referenceImages = mapBlueprintReferenceImages(snapshotRecord.referenceImages);
    return snapshotRecord;
  };

  return nodes
    .map((node) => {
      if (!node || typeof node !== 'object') {
        return null;
      }

      const nodeData =
        node.data && typeof node.data === 'object'
          ? node.data as Record<string, unknown>
          : {};
      const nextData: Record<string, unknown> = { ...nodeData };

      for (const key of [
        'imageUrl',
        'previewImageUrl',
        'thumbnailUrl',
        'sourceImageUrl',
        'snapshotUrl',
        'backgroundImageUrl',
        'backgroundPanoramaUrl',
        'videoUrl',
        'localVideoUrl',
        'audioUrl',
        'localAudioUrl',
      ]) {
        if (key in nextData) {
          nextData[key] = mapImageUrl(nextData[key] as string | null | undefined) ?? null;
        }
      }

      if (typeof nextData.generationRetryResultUrl === 'string'
        && /^(?:data|blob):/i.test(nextData.generationRetryResultUrl.trim())) {
        nextData.generationRetryResultUrl = null;
      }
      // A `blob:` URL never outlives its page; a stored one renders as a broken image (canvas,
      // asset library). When the other copy survived, use it: a dead preview falls back to the
      // full image, a dead full image to its preview (older browser builds kept only the preview
      // durable). A node with neither keeps its URLs so its recovery path can run.
      const isBlob = (value: unknown) => typeof value === 'string' && /^blob:/i.test(value);
      const isDurable = (value: unknown) => typeof value === 'string' && value.length > 0 && !isBlob(value);
      if (isBlob(nextData.previewImageUrl) && isDurable(nextData.imageUrl)) {
        nextData.mediaReferences = {
          ...(nextData.mediaReferences && typeof nextData.mediaReferences === 'object' ? nextData.mediaReferences : {}),
          previewImageUrl: { status: 'missing', source: nextData.previewImageUrl, reason: 'unavailable-blob' },
        };
        nextData.previewImageUrl = nextData.imageUrl;
      } else if (isBlob(nextData.imageUrl) && isDurable(nextData.previewImageUrl)) {
        nextData.mediaReferences = {
          ...(nextData.mediaReferences && typeof nextData.mediaReferences === 'object' ? nextData.mediaReferences : {}),
          imageUrl: { status: 'missing', source: nextData.imageUrl, reason: 'unavailable-blob' },
        };
        nextData.imageUrl = nextData.previewImageUrl;
      }

      if (Array.isArray(nextData.frames)) {
        nextData.frames = nextData.frames.map((frame) => {
          if (!frame || typeof frame !== 'object') {
            return frame;
          }

          const frameRecord = frame as Record<string, unknown>;
          if (!('imageUrl' in frameRecord)) {
            return frame;
          }

          return {
            ...frameRecord,
            imageUrl: mapImageUrl(frameRecord.imageUrl as string | null | undefined) ?? null,
            previewImageUrl:
              mapImageUrl(frameRecord.previewImageUrl as string | null | undefined) ?? null,
          };
        });
      }

      // Director Studio / blueprint data can carry large dataURLs in
      // snapshots, snapshot histories, backgrounds, `items[].refImageUrl`, and
      // `referenceImages[].url`. Treat all of them the same way as normal node
      // image fields so projects round-trip without duplicating base64 payloads.
      if ('snapshotHistory' in nextData) {
        nextData.snapshotHistory = mapImageUrlList(nextData.snapshotHistory);
      }
      if ('items' in nextData) {
        nextData.items = mapBlueprintItems(nextData.items);
      }
      if ('referenceImages' in nextData) {
        nextData.referenceImages = mapBlueprintReferenceImages(nextData.referenceImages);
      }
      if (Array.isArray(nextData.directorStudioProjects)) {
        nextData.directorStudioProjects = nextData.directorStudioProjects.map((project) => {
          if (!project || typeof project !== 'object') return project;
          const rec = project as Record<string, unknown>;
          return {
            ...rec,
            coverUrl: mapImageUrl(rec.coverUrl as string | null | undefined) ?? null,
            snapshot: mapDirectorProjectSnapshot(rec.snapshot),
          };
        });
      }

      return {
        ...node,
        data: nextData as CanvasNodeData,
      };
    })
    .filter((node): node is CanvasNode => Boolean(node));
}

function mapHistoryImageReferences(
  history: CanvasHistoryState,
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasHistoryState {
  const mapValue = (value: unknown, path: Array<string | number>): unknown => {
    const key = path[path.length - 1];
    if (key === 'generationRetryResultUrl' && typeof value === 'string' && /^(?:data|blob):/i.test(value.trim())) return null;
    if (typeof key === 'string' && HISTORY_MEDIA_FIELDS[key] && (typeof value === 'string' || value === null || value === undefined)) return mapImageUrl(value);
    if (path[path.length - 2] === 'snapshotHistory' && typeof value === 'string') return mapImageUrl(value);
    if (Array.isArray(value)) return value.map((item, index) => mapValue(item, [...path, index]));
    if (!value || typeof value !== 'object') return value;
    // Whole inserted/removed nodes use exactly the same media repair rules as the live graph.
    if (path[0] === 'nodes' && path.length === 2) return mapNodeImageReferences([value as CanvasNode], mapImageUrl)[0];
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, mapValue(item, [...path, field])]));
  };
  return mapCanvasHistoryValues(history, mapValue);
}

function trimHistoryForPersistence(history: CanvasHistoryState): CanvasHistoryState {
  return trimCanvasHistory(history, MAX_PERSISTED_HISTORY_STEPS);
}

export function encodeProject(project: Project): Project & { imagePool: string[] } {
  const imagePool: string[] = [];
  const imageIndexMap = new Map<string, number>();
  const encode = (imageUrl: string | null | undefined) =>
    encodeImageReference(imageUrl, imagePool, imageIndexMap);

  return {
    ...project,
    nodes: mapNodeImageReferences(project.nodes, encode),
    history: mapHistoryImageReferences(trimHistoryForPersistence(project.history), encode),
    imagePool,
  };
}

/** Reconstruct each reachable historical graph before migrating it, including patch-era records. */
function historySnapshots(history: CanvasHistoryState, current: CanvasGraph): { past: CanvasGraph[]; future: CanvasGraph[] } {
  const stack = (entries: CanvasHistoryState['past'], direction: 'undo' | 'redo'): CanvasGraph[] => {
    let cursor = current;
    return entries.slice().reverse().map((entry) => {
      cursor = applyCanvasHistoryEntry(cursor, entry, direction);
      return { ...cursor,
        ...(entry.groupId ? { historyGroupId: entry.groupId } : {}),
        ...(entry.agentTurnId ? { historyAgentTurnId: entry.agentTurnId } : {}),
      };
    }).reverse();
  };
  return { past: stack(history.past, 'undo'), future: stack(history.future, 'redo') };
}

export function decodeProject(project: PersistedProject): Project {
  const { imagePool, ...fields } = project;
  const decode = (imageUrl: string | null | undefined) => decodeImageReference(imageUrl, imagePool);
  const rawCurrent = { nodes: project.nodes, edges: project.edges };
  const decodedCurrent = { nodes: mapNodeImageReferences(project.nodes, decode), edges: project.edges };
  const rawHistory = normalizeCanvasHistory(project.history, rawCurrent);
  const decodedHistory = mapHistoryImageReferences(rawHistory, decode);
  const current = normalizeCanvasGraph(decodedCurrent.nodes, decodedCurrent.edges);
  const history = normalizeCanvasHistory(historySnapshots(decodedHistory, decodedCurrent), current,
    (graph) => normalizeCanvasGraph(graph.nodes, graph.edges));
  return { ...fields, ...current, nodeCount: current.nodes.length, history: trimHistoryForPersistence(history) };
}

/** Resolve legacy URL fields to committed asset ids without submitting generation or dropping evidence. */
export async function migrateProjectMedia(project: Project, resolver?: ProjectMediaResolver): Promise<Project> {
  const cache = new Map<string, Promise<ProjectMediaResolution | null>>();
  let assets: Promise<AssetRecord[]> | undefined;
  const resolve: ProjectMediaResolver = (request) => {
    const key = `${request.kind}:${request.assetId ?? request.source}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolver ? resolver(request) : (async () => {
        assets ??= listAssets();
        const existing = (await assets).find((asset) => asset.kind === request.kind && (request.assetId
          ? asset.id === request.assetId
          : !asset.id.startsWith('project:') && asset.source === request.source));
        if (existing && !/^(?:blob|data):/i.test(existing.source)) return { assetId: existing.id, source: existing.source };
        if (request.assetId && !existing) return null;
        const saved = await saveAsset({ id: existing?.id, kind: request.kind, source: existing?.source ?? request.source, name: existing?.name ?? request.name,
          origin: existing?.origin ?? 'uploaded', projectId: existing?.projectId ?? project.id, nodeId: existing?.nodeId ?? request.nodeId,
          favorite: existing?.favorite, createdAt: existing?.createdAt, previewUrl: existing?.previewUrl,
          metadata: { ...existing?.metadata, migratedFromLegacyProject: true } });
        return { assetId: saved.id, source: saved.source };
      })();
      cache.set(key, pending);
    }
    return pending;
  };
  const migrateGraph = async (graph: CanvasGraph): Promise<CanvasGraph> => ({ ...graph, nodes: await migrateCanvasNodeMedia(graph.nodes, resolve) });
  const current = await migrateGraph(project);
  const snapshots = historySnapshots(project.history, project);
  const past = await Promise.all(snapshots.past.map(migrateGraph));
  const future = await Promise.all(snapshots.future.map(migrateGraph));
  const migratedGraphs = [current, ...past, ...future];
  if ([project, ...snapshots.past, ...snapshots.future].every((before, index) => {
    const after = migratedGraphs[index];
    return before.nodes.length === after.nodes.length && before.nodes.every((node, nodeIndex) => node === after.nodes[nodeIndex]);
  })) return project;
  const history = normalizeCanvasHistory({ past, future }, current);
  return { ...project, ...current, history: trimHistoryForPersistence(history) };
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractImagePoolFromHistoryJson(historyJson: string): string[] {
  const imagePoolKey = '"imagePool"';
  const keyIndex = historyJson.indexOf(imagePoolKey);
  if (keyIndex < 0) {
    return [];
  }

  const arrayStart = historyJson.indexOf('[', keyIndex + imagePoolKey.length);
  if (arrayStart < 0) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;

  for (let index = arrayStart; index < historyJson.length; index += 1) {
    const char = historyJson[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = index;
        break;
      }
    }
  }

  if (arrayEnd < 0) {
    return [];
  }

  const rawArrayJson = historyJson.slice(arrayStart, arrayEnd + 1);
  const parsed = safeParseJson<unknown>(rawArrayJson, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string');
}

function parseImagePoolJson(imagePoolJson: string | null | undefined): string[] {
  if (typeof imagePoolJson !== 'string' || imagePoolJson.length === 0) {
    return [];
  }

  const parsed = safeParseJson<unknown>(imagePoolJson, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string');
}

function getTopLevelImagePool(record: ProjectRecord): string[] {
  if (Array.isArray(record.imagePool)) {
    return record.imagePool.filter((item): item is string => typeof item === 'string');
  }

  return parseImagePoolJson(record.imagePoolJson);
}

function toProjectSummary(record: ProjectSummaryRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

function toProjectRecord(project: Project): ProjectRecord {
  const encodedProject = encodeProject(project);
  const persistedNodes = encodedProject.nodes;
  const persistedHistory = trimHistoryForPersistence(encodedProject.history);
  const nodesJson = JSON.stringify(persistedNodes);
  // The pool has its own column. Keeping it out of history also makes the restore-size bound
  // independent of a large unchanged image in the current graph.
  const historyJson = JSON.stringify(persistedHistory);

  return {
    id: encodedProject.id,
    name: encodedProject.name,
    createdAt: encodedProject.createdAt,
    updatedAt: encodedProject.updatedAt,
    nodeCount: encodedProject.nodeCount,
    nodesJson,
    edgesJson: JSON.stringify(encodedProject.edges),
    viewportJson: JSON.stringify(encodedProject.viewport),
    historyJson,
    imagePoolJson: JSON.stringify(encodedProject.imagePool ?? []),
  };
}

function fromProjectRecord(record: ProjectRecord): Project {
  const parsedNodes = safeParseJson<CanvasNode[]>(record.nodesJson, []);
  const parsedEdges = safeParseJson<CanvasEdge[]>(record.edgesJson, []);
  const parsedViewport = safeParseJson<Viewport>(record.viewportJson, DEFAULT_VIEWPORT);
  const shouldRestoreHistory = record.historyJson.length <= MAX_HISTORY_BYTES;
  const topLevelImagePool = getTopLevelImagePool(record);
  const extractedImagePool = extractImagePoolFromHistoryJson(record.historyJson);
  const parsedHistoryPayload = shouldRestoreHistory
    ? safeParseJson<{
        past?: CanvasHistoryState['past'];
        future?: CanvasHistoryState['future'];
        imagePool?: string[];
      }>(record.historyJson, {})
    : {};

  if (!shouldRestoreHistory) {
    console.warn(
      `Skip restoring oversized history payload (${record.historyJson.length} chars) for project ${record.id}`
    );
  }

  const parsedHistory = {
    past: parsedHistoryPayload.past ?? [],
    future: parsedHistoryPayload.future ?? [],
  };
  const historyImagePool = parsedHistoryPayload.imagePool ?? extractedImagePool;

  const persistedProject: PersistedProject = {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    nodes: parsedNodes,
    edges: parsedEdges,
    viewport: parsedViewport ?? DEFAULT_VIEWPORT,
    history: parsedHistory,
    imagePool: topLevelImagePool.length > 0 ? topLevelImagePool : historyImagePool,
  };

  const decodedProject = decodeProject(persistedProject);

  return {
    ...decodedProject,
    nodeCount: parsedNodes.length,
    viewport: decodedProject.viewport ?? DEFAULT_VIEWPORT,
    history: decodedProject.history ?? createEmptyHistory(),
  };
}

interface PersistProjectOptions {
  immediate?: boolean;
  debounceMs?: number;
}

interface PersistViewportOptions {
  immediate?: boolean;
  debounceMs?: number;
}

function scheduleIdlePersist(task: () => void): () => void {
  const idleHost = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let active = true;
  const run = () => { if (active) { active = false; task(); } };
  if (typeof idleHost.requestIdleCallback === 'function') {
    const handle = idleHost.requestIdleCallback(run, { timeout: IDLE_PERSIST_TIMEOUT_MS });
    return () => { active = false; idleHost.cancelIdleCallback?.(handle); };
  }
  const handle = setTimeout(run, FALLBACK_IDLE_DELAY_MS);
  return () => { active = false; clearTimeout(handle); };
}

function hasViewportMeaningfulDelta(current: Viewport, next: Viewport): boolean {
  return (
    Math.abs(current.x - next.x) > VIEWPORT_EPSILON ||
    Math.abs(current.y - next.y) > VIEWPORT_EPSILON ||
    Math.abs(current.zoom - next.zoom) > VIEWPORT_EPSILON
  );
}

function normalizeViewport(viewport: Viewport): Viewport {
  return {
    x: Number(viewport.x.toFixed(2)),
    y: Number(viewport.y.toFixed(2)),
    zoom: Number(viewport.zoom.toFixed(4)),
  };
}

function clearQueuedProjectUpsert(projectId: string): void {
  const timer = projectUpsertTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    projectUpsertTimers.delete(projectId);
  }
  queuedProjectUpserts.get(projectId)?.cancelIdle?.();
  queuedProjectUpserts.delete(projectId);
}

function clearQueuedViewportUpsert(projectId: string): void {
  const timer = viewportUpsertTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    viewportUpsertTimers.delete(projectId);
  }
  queuedViewportUpserts.delete(projectId);
}

interface FlushProjectUpsertOptions {
  bypassIdle?: boolean;
}

function flushProjectUpsert(projectId: string, options?: FlushProjectUpsertOptions): void {
  if (deletingProjectIds.has(projectId) || projectUpsertsInFlight.has(projectId)) {
    return;
  }

  const queued = queuedProjectUpserts.get(projectId);
  if (!queued) {
    return;
  }

  const settle = () => {
    projectUpsertsInFlight.delete(projectId);

    if (deletingProjectIds.has(projectId)) {
      return;
    }

    const next = queuedProjectUpserts.get(projectId);
    if (next) {
      // Propagate immediate intent so close-time data isn't deferred to
      // requestIdleCallback (up to 1.2s) when a prior in-flight upsert
      // had to settle first.
      flushProjectUpsert(projectId, { bypassIdle: next.immediate });
    }
    if (queuedViewportUpserts.has(projectId)) flushViewportUpsert(projectId);
  };

  const executePersist = () => {
    // A canceled idle callback may still be delivered by the host. It cannot
    // write a superseded snapshot or resurrect a deleted project.
    if (deletingProjectIds.has(projectId) || queuedProjectUpserts.get(projectId) !== queued) return;
    queued.cancelIdle = undefined;
    if (!options?.bypassIdle && !queued.immediate && isCanvasViewportInteractionActive()
      && Date.now() - queued.queuedAt < MAX_INTERACTION_PERSIST_DELAY_MS) {
      const timer = setTimeout(() => {
        projectUpsertTimers.delete(projectId);
        flushProjectUpsert(projectId);
      }, INTERACTION_PERSIST_RECHECK_MS);
      projectUpsertTimers.set(projectId, timer);
      return;
    }
    const timer = projectUpsertTimers.get(projectId);
    if (timer) clearTimeout(timer);
    projectUpsertTimers.delete(projectId);
    queuedProjectUpserts.delete(projectId);
    projectUpsertsInFlight.add(projectId);
    // Defer serialization itself, not only the IPC write. Capture synchronous
    // encoding failures in the same checkpoint failure path as storage errors.
    void Promise.resolve().then(() => upsertProjectRecord(toProjectRecord(queued.project)))
      .then(() => {
        projectUpsertFailures.delete(projectId);
      })
      .catch((error) => {
        projectUpsertFailures.set(projectId, error);
        console.error('Failed to persist project record', { projectId, error });
      })
      .finally(settle);
  };

  if (options?.bypassIdle || queued.immediate) {
    queued.cancelIdle?.();
    executePersist();
    return;
  }
  if (!queued.cancelIdle) queued.cancelIdle = scheduleIdlePersist(executePersist);
}

function queueProjectUpsert(project: Project, options?: PersistProjectOptions): void {
  const projectId = project.id;
  deletingProjectIds.delete(projectId);
  const requestImmediate = options?.immediate === true;
  // Don't downgrade an existing immediate request — once close-time data
  // is queued, it should always flush ASAP regardless of subsequent
  // non-immediate persists.
  const existing = queuedProjectUpserts.get(projectId);
  const immediate = requestImmediate || (existing?.immediate ?? false);
  existing?.cancelIdle?.();
  queuedProjectUpserts.set(projectId, { project, immediate, queuedAt: existing?.queuedAt ?? Date.now() });

  const existingTimer = projectUpsertTimers.get(projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    projectUpsertTimers.delete(projectId);
  }

  const debounceMs = requestImmediate ? 0 : (options?.debounceMs ?? UPSERT_DEBOUNCE_MS);
  if (debounceMs <= 0) {
    flushProjectUpsert(projectId, { bypassIdle: true });
    return;
  }

  const timer = setTimeout(() => {
    projectUpsertTimers.delete(projectId);
    flushProjectUpsert(projectId);
  }, debounceMs);
  projectUpsertTimers.set(projectId, timer);
}

/**
 * Resolve once any pending project-upsert work for `projectId` has fully
 * drained — debounce timers fired, queued entries flushed, in-flight
 * promises settled. Polling rather than promise-tracking is deliberate:
 * the queue/inflight state can transition multiple times (queued → flush
 * → inflight → settle → queued → flush → ...) and a polling loop
 * naturally walks through every transition.
 *
 * Used by `openProject` to eliminate the close-then-reopen race where
 * `closeProject`'s fire-and-forget upsert hasn't reached SQLite by the
 * time `getProjectRecord` queries it. Without this drain, a fast user
 * (back button → reopen tile within 200ms) would read pre-close data and
 * see "items disappear after exit/reopen".
 */
async function awaitProjectPersistDrain(projectId: string): Promise<void> {
  // Explicit checkpoints promote even an idle/interaction-deferred snapshot.
  // An in-flight write will pass this immediate intent to its next queued write.
  const promotePending = () => {
    const queued = queuedProjectUpserts.get(projectId);
    if (queued) queued.immediate = true;
    const timer = projectUpsertTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      projectUpsertTimers.delete(projectId);
    }
    flushProjectUpsert(projectId, { bypassIdle: true });
  };
  promotePending();

  // Then poll until queue + inflight + timers are all clear.
  let waited = 0;
  const POLL_MS = 12;
  const MAX_WAIT_MS = 5_000;
  while (
    queuedProjectUpserts.has(projectId) ||
    projectUpsertsInFlight.has(projectId) ||
    projectUpsertTimers.has(projectId)
  ) {
    if (waited >= MAX_WAIT_MS) {
      throw new Error(`Project persistence timed out after ${MAX_WAIT_MS}ms for ${projectId}.`);
    }
    promotePending();
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    waited += POLL_MS;
  }

  const failure = projectUpsertFailures.get(projectId);
  if (failure !== undefined) {
    projectUpsertFailures.delete(projectId);
    throw failure instanceof Error
      ? failure
      : new Error(`Failed to persist project ${projectId}.`);
  }
}

function persistProject(project: Project, options?: PersistProjectOptions): void {
  clearQueuedViewportUpsert(project.id);
  queueProjectUpsert(project, options);
}

function flushViewportUpsert(projectId: string): void {
  if (deletingProjectIds.has(projectId) || viewportUpsertsInFlight.has(projectId) || projectUpsertsInFlight.has(projectId)) {
    return;
  }

  const viewportJson = queuedViewportUpserts.get(projectId);
  if (typeof viewportJson !== 'string') {
    return;
  }

  queuedViewportUpserts.delete(projectId);
  viewportUpsertsInFlight.add(projectId);

  void updateProjectViewportRecord(projectId, viewportJson)
    .catch((error) => {
      console.error('Failed to persist project viewport', error);
    })
    .finally(() => {
      viewportUpsertsInFlight.delete(projectId);

      if (deletingProjectIds.has(projectId)) {
        return;
      }

      if (queuedViewportUpserts.has(projectId)) {
        flushViewportUpsert(projectId);
      }
    });
}

function queueViewportUpsert(
  projectId: string,
  viewport: Viewport,
  options?: PersistViewportOptions
): void {
  deletingProjectIds.delete(projectId);
  queuedViewportUpserts.set(projectId, JSON.stringify(viewport));

  const existingTimer = viewportUpsertTimers.get(projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    viewportUpsertTimers.delete(projectId);
  }

  const debounceMs = options?.immediate ? 0 : (options?.debounceMs ?? VIEWPORT_UPSERT_DEBOUNCE_MS);
  if (debounceMs <= 0) {
    flushViewportUpsert(projectId);
    return;
  }

  const timer = setTimeout(() => {
    viewportUpsertTimers.delete(projectId);
    flushViewportUpsert(projectId);
  }, debounceMs);
  viewportUpsertTimers.set(projectId, timer);
}

function persistProjectDelete(projectId: string): void {
  deletingProjectIds.add(projectId);
  clearQueuedProjectUpsert(projectId);
  clearQueuedViewportUpsert(projectId);

  const attemptDelete = (retryCount: number): void => {
    if (projectUpsertsInFlight.has(projectId) || viewportUpsertsInFlight.has(projectId)) {
      if (retryCount >= MAX_DELETE_RETRIES) {
        deletingProjectIds.delete(projectId);
        return;
      }

      setTimeout(() => {
        attemptDelete(retryCount + 1);
      }, DELETE_RETRY_DELAY_MS);
      return;
    }

    void deleteProjectRecord(projectId)
      .catch((error) => {
        console.error('Failed to delete project record', error);
      })
      .finally(() => {
        deletingProjectIds.delete(projectId);
      });
  };

  attemptDelete(0);
}

function updateProjectSummary(
  summaries: ProjectSummary[],
  updated: ProjectSummary
): ProjectSummary[] {
  const next = summaries.map((summary) => (summary.id === updated.id ? updated : summary));
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

function upsertProjectSummary(
  summaries: ProjectSummary[],
  updated: ProjectSummary
): ProjectSummary[] {
  const exists = summaries.some((summary) => summary.id === updated.id);
  const next = exists
    ? summaries.map((summary) => (summary.id === updated.id ? updated : summary))
    : [updated, ...summaries];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

function resolvePromptNodePosition(nodes: CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) {
    return { x: 120, y: 96 };
  }

  let rightEdge = Number.NEGATIVE_INFINITY;
  let topEdge = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const x = Number.isFinite(node.position.x) ? node.position.x : 0;
    const y = Number.isFinite(node.position.y) ? node.position.y : 0;
    const width = Number.isFinite(node.measured?.width)
      ? node.measured?.width ?? DEFAULT_NODE_WIDTH
      : (Number.isFinite(node.width) ? node.width ?? DEFAULT_NODE_WIDTH : DEFAULT_NODE_WIDTH);
    rightEdge = Math.max(rightEdge, x + width);
    topEdge = Math.min(topEdge, y);
  }

  return {
    x: Number.isFinite(rightEdge) ? rightEdge + 96 : 120,
    y: Number.isFinite(topEdge) ? topEdge : 96,
  };
}


function addPromptNodeToProject(
  project: Project,
  seed: PromptCanvasSeed,
  updatedAt: number
): Project {
  const trimmedPrompt = seed.prompt.trim();
  const displayName = seed.title.trim() || 'Prompt';
  const node = canvasNodeFactory.createNode(
    CANVAS_NODE_TYPES.imageEdit,
    resolvePromptNodePosition(project.nodes),
    {
      displayName,
      prompt: trimmedPrompt,
    }
  );
  const nextNodes = [...project.nodes, node];

  return {
    ...project,
    nodes: nextNodes,
    history: appendCanvasHistory(
      project.history ?? createEmptyHistory(),
      project,
      { nodes: nextNodes, edges: project.edges },
    ),
    nodeCount: nextNodes.length,
    updatedAt,
  };
}

interface ProjectState {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  currentProject: Project | null;
  isHydrated: boolean;
  isOpeningProject: boolean;

  hydrate: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  waitForProjectPersistence: (projectId: string) => Promise<void>;
  createProject: (name: string) => string;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  applyPromptToCanvas: (target: PromptCanvasTarget, seed: PromptCanvasSeed) => Promise<void>;
  openProject: (id: string) => void;
  closeProject: () => void;
  getCurrentProject: () => Project | null;
  saveCurrentProject: (
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    viewport?: Viewport,
    history?: CanvasHistoryState
  ) => void;
  saveCurrentProjectViewport: (viewport: Viewport) => void;
  cancelPendingViewportPersist: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  currentProject: null,
  isHydrated: false,
  isOpeningProject: false,

  hydrate: async () => {
    if (get().isHydrated) {
      return;
    }

    try {
      const records = await listProjectSummaries();
      const projects = records.map(toProjectSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      set({
        projects,
        currentProjectId: null,
        currentProject: null,
        isHydrated: true,
      });
    } catch (error) {
      console.error('Failed to hydrate project summaries from project storage', error);
      set({
        projects: [],
        currentProjectId: null,
        currentProject: null,
        isHydrated: true,
      });
    }
  },

  refreshProjects: async () => {
    try {
      const records = await listProjectSummaries();
      const projects = records.map(toProjectSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      set({ projects, isHydrated: true });
    } catch (error) {
      console.error('Failed to refresh project summaries from project storage', error);
      throw error;
    }
  },

  waitForProjectPersistence: async (projectId) => {
    await awaitProjectPersistDrain(projectId);
  },

  createProject: (name) => {
    flushPendingCanvasViewport();
    const id = uuidv4();
    const now = Date.now();
    const project: Project = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      nodeCount: 0,
      nodes: [],
      edges: [],
      viewport: DEFAULT_VIEWPORT,
      history: createEmptyHistory(),
    };

    set((state) => ({
      projects: [{ ...project }, ...state.projects],
      currentProjectId: id,
      currentProject: project,
      isOpeningProject: false,
    }));
    persistProject(project, { immediate: true });
    return id;
  },

  deleteProject: (id) => {
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
      currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
      isOpeningProject: false,
    }));

    persistProjectDelete(id);
  },

  renameProject: (id, name) => {
    const now = Date.now();

    set((state) => {
      const projects = state.projects.map((summary) =>
        summary.id === id
          ? {
              ...summary,
              name,
              updatedAt: now,
            }
          : summary
      );

      return {
        projects: projects.sort((a, b) => b.updatedAt - a.updatedAt),
        currentProject:
          state.currentProject?.id === id
            ? {
                ...state.currentProject,
                name,
                updatedAt: now,
              }
            : state.currentProject,
      };
    });

    const nextCurrentProject = get().currentProject?.id === id ? get().currentProject : null;
    if (nextCurrentProject) {
      persistProject(nextCurrentProject, { immediate: true });
      return;
    }

    void renameProjectRecord(id, name, now).catch((error) => {
      console.error('Failed to rename project record', error);
    });
  },

  applyPromptToCanvas: async (target, seed) => {
    const prompt = seed.prompt.trim();
    if (!prompt) {
      throw new Error('Prompt is empty');
    }

    const now = Date.now();
    let targetProject: Project | null = null;

    if (target.kind === 'new') {
      const name = target.name.trim();
      if (!name) {
        throw new Error('Project name is empty');
      }

      targetProject = {
        id: uuidv4(),
        name,
        createdAt: now,
        updatedAt: now,
        nodeCount: 0,
        nodes: [],
        edges: [],
        viewport: DEFAULT_VIEWPORT,
        history: createEmptyHistory(),
      };
    } else {
      await awaitProjectPersistDrain(target.projectId);
      const { currentProjectId, currentProject } = get();

      if (currentProjectId === target.projectId && currentProject?.id === target.projectId) {
        const canvasState = useCanvasStore.getState();
        targetProject = {
          ...currentProject,
          nodes: canvasState.nodes,
          edges: canvasState.edges,
          viewport: canvasState.currentViewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT,
          history: canvasState.history ?? currentProject.history ?? createEmptyHistory(),
          nodeCount: canvasState.nodes.length,
        };
      } else {
        const record = await getProjectRecord(target.projectId);
        if (!record) {
          throw new Error('Project not found');
        }
        targetProject = fromProjectRecord(record);
      }
    }

    const nextProject = addPromptNodeToProject(targetProject, seed, now);
    const nextSummary: ProjectSummary = {
      id: nextProject.id,
      name: nextProject.name,
      createdAt: nextProject.createdAt,
      updatedAt: nextProject.updatedAt,
      nodeCount: nextProject.nodeCount,
    };

    set((state) => ({
      projects: upsertProjectSummary(state.projects, nextSummary),
      currentProject:
        state.currentProject?.id === nextProject.id ? nextProject : state.currentProject,
    }));
    persistProject(nextProject, { immediate: true });
    get().openProject(nextProject.id);
  },

  openProject: (id) => {
    flushPendingCanvasViewport();
    const reqSeq = ++openProjectRequestSeq;
    useCanvasStore.getState().closeImageViewer();
    set({ isOpeningProject: true });

    void (async () => {
      try {
        // Drain any pending writes for this project first. Without this, the
        // close-then-reopen race lets the read fire before the previous
        // upsert reaches SQLite, returning pre-close state. The Rust side
        // also serializes via a shared connection mutex (see ProjectDb in
        // commands/project_state.rs) — these two layers are belt + suspenders.
        await awaitProjectPersistDrain(id);

        const record = await getProjectRecord(id);
        if (reqSeq !== openProjectRequestSeq) {
          return;
        }
        if (!record) {
          set({ isOpeningProject: false });
          return;
        }

        const project = await migrateProjectMedia(fromProjectRecord(record));
        if (reqSeq !== openProjectRequestSeq) return;
        set((state) => ({
          currentProjectId: id,
          currentProject: project,
          isOpeningProject: false,
          projects: updateProjectSummary(state.projects, {
            id: project.id,
            name: project.name,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            nodeCount: project.nodeCount,
          }),
        }));
      } catch (error) {
        if (reqSeq !== openProjectRequestSeq) {
          return;
        }
        console.error('Failed to open project', error);
        set({ isOpeningProject: false });
      }
    })();
  },

  closeProject: () => {
    flushPendingCanvasViewport();
    openProjectRequestSeq += 1;
    useCanvasStore.getState().closeImageViewer();
    const { currentProjectId, currentProject } = get();
    let persistedSummary: ProjectSummary | null = null;

    if (currentProjectId && currentProject && currentProject.id === currentProjectId) {
      const canvasState = useCanvasStore.getState();
      const nextProject: Project = {
        ...currentProject,
        nodes: canvasState.nodes,
        edges: canvasState.edges,
        viewport: canvasState.currentViewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT,
        history: canvasState.history ?? currentProject.history ?? createEmptyHistory(),
        nodeCount: canvasState.nodes.length,
        updatedAt: Date.now(),
      };

      persistedSummary = {
        id: nextProject.id,
        name: nextProject.name,
        createdAt: nextProject.createdAt,
        updatedAt: nextProject.updatedAt,
        nodeCount: nextProject.nodeCount,
      };
      persistProject(nextProject, { immediate: true });
    }

    set((state) => ({
      projects: persistedSummary
        ? updateProjectSummary(state.projects, persistedSummary)
        : state.projects,
      currentProjectId: null,
      currentProject: null,
      isOpeningProject: false,
    }));
  },

  getCurrentProject: () => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject) {
      return null;
    }
    if (currentProject.id !== currentProjectId) {
      return null;
    }
    return currentProject;
  },

  saveCurrentProject: (nodes, edges, viewport, history) => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
      return;
    }

    const nextViewport = viewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT;
    const nextHistory = history ?? currentProject.history ?? createEmptyHistory();
    const nextNodeCount = nodes.length;

    const hasViewportChanged =
      currentProject.viewport.x !== nextViewport.x ||
      currentProject.viewport.y !== nextViewport.y ||
      currentProject.viewport.zoom !== nextViewport.zoom;
    const hasChanged =
      currentProject.nodes !== nodes ||
      currentProject.edges !== edges ||
      currentProject.history !== nextHistory ||
      currentProject.nodeCount !== nextNodeCount ||
      hasViewportChanged;
    if (!hasChanged) {
      return;
    }

    const nextProject: Project = {
      ...currentProject,
      nodes,
      edges,
      viewport: nextViewport,
      history: nextHistory,
      nodeCount: nextNodeCount,
      updatedAt: Date.now(),
    };

    set((state) => ({
      currentProject: nextProject,
      projects: updateProjectSummary(state.projects, {
        id: nextProject.id,
        name: nextProject.name,
        createdAt: nextProject.createdAt,
        updatedAt: nextProject.updatedAt,
        nodeCount: nextProject.nodeCount,
      }),
    }));
    persistProject(nextProject);
  },

  saveCurrentProjectViewport: (viewport) => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
      return;
    }

    const nextViewport = normalizeViewport(viewport);
    const hasChanged = hasViewportMeaningfulDelta(currentProject.viewport, nextViewport);
    if (!hasChanged) {
      return;
    }

    const nextProject: Project = {
      ...currentProject,
      viewport: nextViewport,
    };

    set({ currentProject: nextProject });
    // A delayed graph snapshot must not overwrite a newer viewport that reached
    // storage first. Keep its graph/history, updating only the committed camera.
    const queued = queuedProjectUpserts.get(currentProjectId);
    if (queued) queued.project = { ...queued.project, viewport: nextViewport };
    queueViewportUpsert(currentProjectId, nextViewport);
  },

  cancelPendingViewportPersist: () => {
    const currentProjectId = get().currentProjectId;
    if (!currentProjectId) {
      return;
    }
    clearQueuedViewportUpsert(currentProjectId);
  },
}));
