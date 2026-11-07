import { useCallback, useMemo, useRef } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import type { MaterialImportApi } from '@/features/canvas/io/useMaterialImport';
import { useProjectStore } from '@/stores/projectStore';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { usePasteBridge } from './usePasteBridge';
import { duplicateCanvasGraph } from './canvasDuplication';
import { decodeCanvasClipboard, encodeCanvasClipboard } from './canvasClipboardFormat';
import {
  cloneNodeData, collectNodeIdsWithDescendants, createUiNodeId, getNodeSize, getSnapshotBounds,
  hasRectCollision, readClipboardContent, resolveAbsoluteNodePosition,
  sortNodesForDuplication, writeTextToClipboard, clipboardMaterialSources,
  type CanvasClipboardSnapshot, type ClipboardContentReadResult,
} from './clipboardIO';

export interface DuplicateOptions {
  explicitOffset?: FlowPoint;
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

export interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

export interface CanvasClipboardApi {
  copyNodes(nodeIds: string[]): void;
  duplicateNodes(nodeIds: string[], options?: DuplicateOptions): DuplicateResult | null;
  pasteFromShortcut(): Promise<boolean>;
  pasteAt(target: { nodeId: string | null; flowPosition: FlowPoint }): Promise<void>;
  copyText(text: string): Promise<void>;
}

// Serialize app-origin writes so a slow earlier copy cannot overwrite a later one.
let pendingClipboardWrite: Promise<void> = Promise.resolve();
function enqueueClipboardWrite(text: string): Promise<void> {
  const pending = pendingClipboardWrite.catch(() => {}).then(() => writeTextToClipboard(text));
  pendingClipboardWrite = pending;
  return pending;
}

export function useCanvasClipboard(options: {
  materialImport: MaterialImportApi;
  resolvePastePosition: () => FlowPoint;
  resolveShortcutPastePosition?: () => Promise<FlowPoint>;
  scheduleCanvasPersist: (delayMs?: number) => void;
}): CanvasClipboardApi {
  const { materialImport, resolvePastePosition, resolveShortcutPastePosition, scheduleCanvasPersist } = options;
  const pasteIterationRef = useRef(0);
  const createClipboardSnapshot = useCallback(
    (sourceNodeIds: string[], inheritExternalEdges = false): CanvasClipboardSnapshot | null => {
      const { nodes, edges } = useCanvasStore.getState();
      const expandedIds = collectNodeIdsWithDescendants(nodes, sourceNodeIds);
      if (expandedIds.length === 0) {
        return null;
      }

      const sourceIdSet = new Set(expandedIds);
      const snapshotNodes = nodes
        .filter((node) => sourceIdSet.has(node.id))
        .map((node) => {
          const copy = cloneNodeData(node);
          if (copy.parentId && !sourceIdSet.has(copy.parentId)) {
            copy.position = resolveAbsoluteNodePosition(node, new Map(nodes.map(item => [item.id, item])));
            delete copy.parentId; delete copy.extent;
          }
          return copy;
        });
      if (snapshotNodes.length === 0) {
        return null;
      }

      return {
        nodes: snapshotNodes,
        edges: edges
          .filter((edge) => inheritExternalEdges
            ? sourceIdSet.has(edge.source) || sourceIdSet.has(edge.target)
            : sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target))
          .map((edge) => cloneNodeData(edge)),
      };
    },
    []
  );

  const copyNodesToClipboard = useCallback((sourceNodeIds: string[]) => {
    const snapshot = createClipboardSnapshot(sourceNodeIds);
    if (!snapshot?.nodes.length) return;
    pasteIterationRef.current = 0;
    void enqueueClipboardWrite(encodeCanvasClipboard(snapshot)).catch(error => {
      void showErrorDialog(error instanceof Error ? error.message : String(error), '复制失败');
    });
  }, [createClipboardSnapshot]);

  const duplicateSnapshot = useCallback(
    (snapshot: CanvasClipboardSnapshot, options: DuplicateOptions = {}): DuplicateResult | null => {
      const sourceNodes = sortNodesForDuplication(snapshot.nodes);
      if (sourceNodes.length === 0) return null;
      const state = useCanvasStore.getState();
      const sourceNodeMap = new Map([...state.nodes, ...sourceNodes].map((node) => [node.id, node]));
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      const baseOffsets = [{ x: 44, y: 30 }, { x: 72, y: 8 }, { x: 18, y: 68 }, { x: 96, y: 42 }];
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];
      const ignoredNodeIds = new Set<string>();
      const isOffsetAvailable = (offset: FlowPoint) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        const absolute = resolveAbsoluteNodePosition(node, sourceNodeMap);
        return !hasRectCollision({
          x: absolute.x + offset.x + offsetStep * 8,
          y: absolute.y + offset.y + offsetStep * 6,
          width: size.width,
          height: size.height,
        }, state.nodes, ignoredNodeIds);
      });
      if (!options.explicitOffset) {
        const matchedOffset = baseOffsets.find(isOffsetAvailable);
        if (matchedOffset) chosenOffset = matchedOffset;
        else {
          for (let step = 1; step <= 16; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }
      const duplicated = duplicateCanvasGraph({
        sourceNodes,
        sourceEdges: snapshot.edges,
        existingNodes: state.nodes,
        existingEdges: state.edges,
        copies: sourceNodes.map((node) => ({ sourceNodeId: node.id, nodeId: createUiNodeId(node.type) })),
        offset: { x: chosenOffset.x + offsetStep * 8, y: chosenOffset.y + offsetStep * 6 },
      });
      const firstNodeId = duplicated.nodes[0]?.id ?? null;
      const selectCopies = !options.suppressSelect;
      if (options.explicitOffset && selectCopies) useCanvasUiStore.setState({ preservePasteViewportFor: firstNodeId });
      const revision = state.commitGraphTransaction({
        expectedRevision: state.revision,
        nodes: [
          ...state.nodes.map((node) => selectCopies && node.selected ? { ...node, selected: false } : node),
          ...duplicated.nodes.map((node) => selectCopies ? { ...node, selected: true } : node),
        ],
        edges: [...state.edges, ...duplicated.edges],
        selectedNodeId: selectCopies ? firstNodeId : state.selectedNodeId,
      });
      if (revision === null) return null;
      if (!options.disableOffsetIteration) pasteIterationRef.current += 1;
      if (!options.suppressPersist) scheduleCanvasPersist(0);
      return { firstNodeId, idMap: duplicated.idMap };
    },
    [scheduleCanvasPersist]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds, true);
      if (!snapshot) {
        return null as DuplicateResult | null;
      }
      return duplicateSnapshot(snapshot, options);
    },
    [createClipboardSnapshot, duplicateSnapshot]
  );

  const copyText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    try { await enqueueClipboardWrite(text); }
    catch (error) { void showErrorDialog(error instanceof Error ? error.message : String(error), '复制失败'); }
  }, []);

  const paste = useCallback(async (target: { nodeId: string | null; flowPosition: FlowPoint }, supplied?: ClipboardContentReadResult): Promise<boolean> => {
    // Freeze coordinates and project before asynchronous clipboard/media I/O.
    const position = { ...target.flowPosition };
    const projectId = useProjectStore.getState().currentProjectId;
    try {
      await pendingClipboardWrite.catch(() => {});
      const content = supplied ?? await readClipboardContent();
      if (useProjectStore.getState().currentProjectId !== projectId) return false;
      if (content.readFailed) throw new Error('无法读取系统剪贴板，请重新复制后再粘贴。');
      const snapshot = decodeCanvasClipboard(content.text);
      if (snapshot) {
        const bounds = getSnapshotBounds(snapshot);
        return Boolean(bounds && duplicateSnapshot(snapshot, { explicitOffset: { x: position.x - bounds.minX, y: position.y - bounds.minY }, disableOffsetIteration: true }));
      }
      const targetNode = target.nodeId ? useCanvasStore.getState().nodes.find(node => node.id === target.nodeId) : undefined;
      const promptTarget = targetNode && (targetNode.type === CANVAS_NODE_TYPES.imageEdit || targetNode.type === CANVAS_NODE_TYPES.aiVideo || targetNode.type === CANVAS_NODE_TYPES.aiText || targetNode.type === CANVAS_NODE_TYPES.aiAudio);
      const files = content.mediaFiles?.length ? content.mediaFiles : [content.mediaFile ?? content.imageFile].filter((file): file is File => Boolean(file));
      const textLines = content.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const sourceCandidates = clipboardMaterialSources(content.filePaths?.length ? content.filePaths : files.length ? [] : textLines);
      // Prose with an embedded media URL is still text. Never discard its other lines.
      const sources = content.filePaths?.length || sourceCandidates.length === textLines.length ? sourceCandidates : [];
      if (files.length || sources.length) {
        let createdCount = 0;
        const inputs = [...files.map(file => ({ file })), ...sources.map(source => ({ source }))];
        for (const [index, input] of inputs.entries()) {
          if (useProjectStore.getState().currentProjectId !== projectId) break;
          const point = { x: position.x + index * 36, y: position.y + index * 36 };
          const created = 'file' in input ? await materialImport.createFromFile(input.file, point) : await materialImport.createFromSource(input.source, point);
          if (created) {
            createdCount++;
            if (promptTarget && targetNode && useCanvasStore.getState().nodes.some(node => node.id === targetNode.id)) useCanvasStore.getState().addEdge(created.nodeId, targetNode.id);
          }
        }
        if (!createdCount) throw new Error('剪贴板素材未能导入，请检查文件是否仍可访问。');
        scheduleCanvasPersist(0);
        return true;
      }
      const text = content.text.trim();
      if (!text) return false;
      const state = useCanvasStore.getState();
      if (promptTarget && targetNode) {
        const current = typeof targetNode.data.prompt === 'string' ? targetNode.data.prompt.trim() : '';
        state.updateNodeData(targetNode.id, { prompt: current ? `${current}\n${text}` : text });
      } else if (targetNode?.type === CANVAS_NODE_TYPES.textAnnotation) {
        const current = typeof targetNode.data.content === 'string' ? targetNode.data.content.trim() : '';
        state.updateNodeData(targetNode.id, { content: current ? `${current}\n${text}` : text });
      } else {
        const id = state.addNode(CANVAS_NODE_TYPES.textAnnotation, position, { content: text });
        state.setSelectedNode(id);
      }
      scheduleCanvasPersist(0);
      return true;
    } catch (error) {
      void showErrorDialog(error instanceof Error ? error.message : String(error), '粘贴失败');
      return false;
    }
  }, [duplicateSnapshot, materialImport, scheduleCanvasPersist]);

  const capturePosition = resolveShortcutPastePosition ?? resolvePastePosition;
  const pasteFromShortcut = useCallback(async (position: FlowPoint | Promise<FlowPoint> = capturePosition(), supplied?: ClipboardContentReadResult) => {
    const projectId = useProjectStore.getState().currentProjectId;
    const captured = await position;
    if (projectId !== useProjectStore.getState().currentProjectId) return false;
    return paste({ nodeId: null, flowPosition: captured }, supplied);
  }, [paste, capturePosition]);
  const pasteAt = useCallback(async (target: { nodeId: string | null; flowPosition: FlowPoint }) => { await paste(target); }, [paste]);
  usePasteBridge({ capturePosition, pasteFromShortcut });
  return useMemo(() => ({ copyNodes: copyNodesToClipboard, duplicateNodes, pasteFromShortcut, pasteAt, copyText }),
    [copyNodesToClipboard, duplicateNodes, pasteFromShortcut, pasteAt, copyText]);
}
