import { useCallback, useMemo, useRef } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, isTagNode, isTagGroupNode, type CanvasNode, type CanvasNodeData, type CanvasNodeType, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { isImageFile } from '@/features/canvas/application/imageDragDrop';
import type { FlowPoint } from '@/features/canvas/state/canvasUiStore';
import type { MaterialImportApi } from '@/features/canvas/io/useMaterialImport';
import { usePasteBridge } from './usePasteBridge';
import {
  buildDuplicateEdge, cloneNodeData, collectNodeIdsWithDescendants, createUiNodeId,
  fingerprintClipboardContent, fingerprintMediaFile, getNodeSize, getSnapshotBounds,
  hasClipboardPayload, hasRectCollision, hashText, isLikelyVideoSourceText,
  readClipboardContent, resolveAbsoluteNodePosition, resolveMediaFingerprintKind,
  sortNodesForDuplication, syncSingleCanvasNodeToSystemClipboard, writeTextToClipboard,
  type CanvasClipboardSnapshot, type ClipboardPasteSource,
  type ClipboardContentReadResult, type SystemClipboardPasteOptions,
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

type ClipboardFreshnessSource = 'internal' | 'system' | null;

function getSelectedTargetNode(): CanvasNode | null {
  const selected = useCanvasStore.getState().nodes.filter((node) => node.selected);
  return selected.length === 1 ? selected[0] : null;
}

export function useCanvasClipboard(options: {
  materialImport: MaterialImportApi;
  resolvePastePosition: () => FlowPoint;
  scheduleCanvasPersist: (delayMs?: number) => void;
}): CanvasClipboardApi {
  const { materialImport, resolvePastePosition, scheduleCanvasPersist } = options;
  const pasteIterationRef = useRef(0);
  const copiedSnapshotRef = useRef<CanvasClipboardSnapshot | null>(null);
  const clipboardFreshnessRef = useRef<ClipboardFreshnessSource>(null);
  const systemClipboardFingerprintAtInternalCopyRef = useRef<string | null | undefined>(null);
  const systemClipboardFingerprintCaptureRef = useRef<Promise<string | null> | null>(null);

  const createClipboardSnapshot = useCallback(
    (sourceNodeIds: string[]): CanvasClipboardSnapshot | null => {
      const { nodes, edges } = useCanvasStore.getState();
      const expandedIds = collectNodeIdsWithDescendants(nodes, sourceNodeIds);
      if (expandedIds.length === 0) {
        return null;
      }

      const sourceIdSet = new Set(expandedIds);
      const snapshotNodes = nodes
        .filter((node) => sourceIdSet.has(node.id))
        .map((node) => cloneNodeData(node));
      if (snapshotNodes.length === 0) {
        return null;
      }

      return {
        nodes: snapshotNodes,
        edges: edges
          .filter((edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target))
          .map((edge) => cloneNodeData(edge)),
      };
    },
    []
  );

  const copyNodesToClipboard = useCallback(
    (sourceNodeIds: string[]) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      copiedSnapshotRef.current = snapshot;
      if (snapshot?.nodes.length) {
        clipboardFreshnessRef.current = 'internal';
        pasteIterationRef.current = 0;
        systemClipboardFingerprintAtInternalCopyRef.current = undefined;
        const capture = syncSingleCanvasNodeToSystemClipboard(snapshot, useCanvasStore.getState().nodes)
          .catch((error) => {
            console.warn('Failed to capture clipboard freshness baseline', error);
            return null;
          });
        systemClipboardFingerprintCaptureRef.current = capture;
        void capture.then((fingerprint) => {
          if (
            systemClipboardFingerprintCaptureRef.current === capture
            && copiedSnapshotRef.current === snapshot
            && clipboardFreshnessRef.current === 'internal'
          ) {
            systemClipboardFingerprintAtInternalCopyRef.current = fingerprint;
          }
        });
      }
    },
    [createClipboardSnapshot]
  );

  const markSystemClipboardFresh = useCallback(() => {
    clipboardFreshnessRef.current = 'system';
    systemClipboardFingerprintAtInternalCopyRef.current = null;
    systemClipboardFingerprintCaptureRef.current = null;
  }, []);

  const resolveClipboardPasteSource = useCallback(async (): Promise<ClipboardPasteSource> => {
    const hasInternalSnapshot = Boolean(copiedSnapshotRef.current?.nodes.length);
    const internalIsFresh = clipboardFreshnessRef.current === 'internal' && hasInternalSnapshot;
    const clipboardContent = await readClipboardContent();

    if (internalIsFresh) {
      let baselineFingerprint = systemClipboardFingerprintAtInternalCopyRef.current;
      const capture = systemClipboardFingerprintCaptureRef.current;
      if (baselineFingerprint === undefined && capture) {
        baselineFingerprint = await capture;
        if (systemClipboardFingerprintCaptureRef.current === capture) {
          systemClipboardFingerprintAtInternalCopyRef.current = baselineFingerprint;
        }
      }

      if (
        clipboardContent.fingerprint
        && baselineFingerprint !== undefined
        && clipboardContent.fingerprint !== baselineFingerprint
      ) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }
      if (clipboardContent.fingerprint && baselineFingerprint === undefined) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }
      return { source: 'internal' };
    }

    if (clipboardContent.imageFile) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    if (clipboardContent.fingerprint) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    return { source: 'none' };
  }, [markSystemClipboardFresh]);

  const duplicateSnapshot = useCallback(
    (snapshot: CanvasClipboardSnapshot, options: DuplicateOptions = {}) => {
      const sourceNodes = sortNodesForDuplication(snapshot.nodes);
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodeMap = new Map(sourceNodes.map((node) => [node.id, node] as const));
      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = snapshot.edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      );
      const tagSourceNodes = sourceNodes.filter((node) => isTagNode(node) || isTagGroupNode(node));
      const taggedSourceIds = new Set(tagSourceNodes.map((node) => node.id));
      const taggedInternalEdges = internalEdges.filter((edge) => (
        taggedSourceIds.has(edge.source) || taggedSourceIds.has(edge.target)
      ));
      if (
        tagSourceNodes.length > 100
        || (tagSourceNodes.length === sourceNodes.length
          && tagSourceNodes.length + taggedInternalEdges.length > 100)
      ) {
        return null as DuplicateResult | null;
      }

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        const absolute = resolveAbsoluteNodePosition(node, sourceNodeMap);
        return !hasRectCollision(
          {
            x: absolute.x + offset.x + offsetStep * 8,
            y: absolute.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      if (tagSourceNodes.length > 0) {
        const tagCopies = tagSourceNodes.map((sourceNode) => {
          const nextNodeId = createUiNodeId(isTagNode(sourceNode) ? 'tag' : 'tag-group');
          const absolute = resolveAbsoluteNodePosition(sourceNode, sourceNodeMap);
          idMap.set(sourceNode.id, nextNodeId);
          return {
            sourceNodeId: sourceNode.id,
            nodeId: nextNodeId,
            position: {
              x: absolute.x + chosenOffset.x + offsetStep * 8,
              y: absolute.y + chosenOffset.y + offsetStep * 6,
            },
          };
        });
        const duplicateCommands: CanvasCommand[] = [{
          type: 'node.duplicate',
          version: CANVAS_COMMAND_VERSION,
          input: { copies: tagCopies },
        }];
        if (tagSourceNodes.length === sourceNodes.length) {
          taggedInternalEdges.forEach((edge) => {
            const sourceNodeId = idMap.get(edge.source);
            const targetNodeId = idMap.get(edge.target);
            if (sourceNodeId && targetNodeId) {
              duplicateCommands.push({
                type: 'edge.connect',
                version: CANVAS_COMMAND_VERSION,
                input: { sourceNodeId, targetNodeId },
              });
            }
          });
        }
        const result = canvasCommandRegistry.executeTransaction({
          id: `ui-duplicate-tags-${Date.now().toString(36)}`,
          origin: 'ui',
          expectedRevision: canvasCommandRegistry.getRevision(),
          commands: duplicateCommands,
        });
        if (!result.ok) {
          return null as DuplicateResult | null;
        }
      }
      for (const sourceNode of sourceNodes) {
        if (taggedSourceIds.has(sourceNode.id)) {
          continue;
        }
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('isStreaming' in (data as Record<string, unknown>)) {
          (data as { isStreaming?: boolean }).isStreaming = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }
        if ('generationRetryResultUrl' in (data as Record<string, unknown>)) {
          (data as { generationRetryResultUrl?: string | null }).generationRetryResultUrl = null;
        }

        const copiedParentId = sourceNode.parentId && sourceIdSet.has(sourceNode.parentId)
          ? sourceNode.parentId
          : null;
        const absolute = resolveAbsoluteNodePosition(sourceNode, sourceNodeMap);
        const nextNodeId = useCanvasStore.getState().addNode(
          sourceNode.type as CanvasNodeType,
          copiedParentId
            ? sourceNode.position
            : {
                x: absolute.x + chosenOffset.x + offsetStep * 8,
                y: absolute.y + chosenOffset.y + offsetStep * 6,
              },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        useCanvasStore.getState().onNodesChange(sizeSyncChanges);
      }

      const sourceIdByCopyId = new Map(Array.from(idMap, ([sourceId, copyId]) => [copyId, sourceId] as const));
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          const sourceId = sourceIdByCopyId.get(currentNode.id);
          if (!sourceId) {
            return currentNode;
          }

          const sourceNode = sourceNodeMap.get(sourceId);
          if (!sourceNode) {
            return currentNode;
          }
          if (isTagNode(sourceNode) || isTagGroupNode(sourceNode)) {
            return currentNode;
          }

          const copiedParentId = sourceNode.parentId ? idMap.get(sourceNode.parentId) : undefined;
          const sourceStyle = sourceNode.style && typeof sourceNode.style === 'object'
            ? cloneNodeData(sourceNode.style)
            : undefined;

          return {
            ...currentNode,
            parentId: copiedParentId,
            extent: copiedParentId ? (sourceNode.extent ?? 'parent') : undefined,
            selected: false,
            style: {
              ...(currentNode.style ?? {}),
              ...(sourceStyle ?? {}),
            },
          };
        }),
      }));

      const ordinaryInternalEdges = internalEdges.filter((edge) => (
        !taggedSourceIds.has(edge.source) && !taggedSourceIds.has(edge.target)
      ));
      if (ordinaryInternalEdges.length > 0) {
        useCanvasStore.setState((state) => {
          const existingEdgeIds = new Set(state.edges.map((edge) => edge.id));
          const duplicatedEdges = ordinaryInternalEdges
            .map((edge) => {
              const nextSource = idMap.get(edge.source);
              const nextTarget = idMap.get(edge.target);
              if (!nextSource || !nextTarget) {
                return null;
              }
              return buildDuplicateEdge(edge, nextSource, nextTarget, existingEdgeIds);
            })
            .filter((edge): edge is CanvasEdge => Boolean(edge));
          if (duplicatedEdges.length === 0) {
            return state;
          }
          return {
            edges: [...state.edges, ...duplicatedEdges],
          };
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        useCanvasStore.getState().setSelectedNodeIds(Array.from(idMap.values()));
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [scheduleCanvasPersist]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      if (!snapshot) {
        return null as DuplicateResult | null;
      }
      return duplicateSnapshot(snapshot, options);
    },
    [createClipboardSnapshot, duplicateSnapshot]
  );

  const pasteCopiedNodes = useCallback(
    (flowPosition?: { x: number; y: number }) => {
      const snapshot = copiedSnapshotRef.current;
      if (!snapshot || snapshot.nodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const bounds = flowPosition ? getSnapshotBounds(snapshot) : null;
      const targetOffset = flowPosition && bounds
        ? {
            x: flowPosition.x - bounds.minX,
            y: flowPosition.y - bounds.minY,
          }
        : null;
      return duplicateSnapshot(
        snapshot,
        targetOffset
          ? {
              explicitOffset: targetOffset,
              disableOffsetIteration: true,
            }
          : undefined
      );
    },
    [duplicateSnapshot]
  );

  const copyText = useCallback(async (text: string) => {
    const selectedText = text.trim();
    if (!selectedText) return;
    try {
      await writeTextToClipboard(selectedText);
      markSystemClipboardFresh();
    } catch (error) {
      console.warn('Failed to copy selected text', error);
    }
  }, [markSystemClipboardFresh]);

  const pasteMaterialAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const created = await materialImport.createFromFile(file, {
        x: targetNode.position.x - 300,
        y: targetNode.position.y,
      });
      if (!created) {
        return false;
      }
      useCanvasStore.getState().addEdge(created.nodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [materialImport, scheduleCanvasPersist]
  );

  const pasteVideoSourceAsNodeReference = useCallback(
    (videoSource: string, targetNode: CanvasNode) => {
      const trimmedSource = videoSource.trim();
      if (!isLikelyVideoSourceText(trimmedSource)) {
        return false;
      }
      const videoNodeId = useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.video,
        {
          x: targetNode.position.x - 300,
          y: targetNode.position.y,
        },
        {
          videoUrl: trimmedSource,
          localVideoUrl: trimmedSource.startsWith('http://') || trimmedSource.startsWith('https://')
            ? null
            : trimmedSource,
          thumbnailUrl: null,
          isGenerating: false,
          sourcePrompt: '',
        }
      );
      useCanvasStore.getState().addEdge(videoNodeId, targetNode.id);
      useCanvasStore.getState().setSelectedNode(videoNodeId);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist]
  );

  const pasteTextIntoPromptNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const data = targetNode.data as { prompt?: unknown };
      const currentPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
      useCanvasStore.getState().updateNodeData(targetNode.id, {
        prompt: currentPrompt ? `${currentPrompt}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist]
  );

  const pasteTextIntoTextNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      if (targetNode.type !== CANVAS_NODE_TYPES.textAnnotation) {
        return false;
      }
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const currentContent = (targetNode.data as { content?: unknown }).content;
      const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
      useCanvasStore.getState().updateNodeData(targetNode.id, {
        content: normalizedCurrent ? `${normalizedCurrent}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist]
  );

  const pasteTextAsTextNode = useCallback(
    (text: string, flowPosition?: { x: number; y: number }) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const nodeId = useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        flowPosition ?? resolvePastePosition(),
        {
          content: trimmedText,
        }
      );
      useCanvasStore.getState().setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
      return true;
    },
    [resolvePastePosition, scheduleCanvasPersist]
  );

  const pasteSystemClipboardContent = useCallback(
    async (
      clipboardContent: ClipboardContentReadResult,
      options: SystemClipboardPasteOptions
    ) => {
      const targetNode = options.targetNode;
      const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
        || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
        || targetNode?.type === CANVAS_NODE_TYPES.aiText;
      const isTextPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.textAnnotation;
      const mediaFile = clipboardContent.mediaFile ?? clipboardContent.imageFile;
      const imageFile = clipboardContent.imageFile ?? (isImageFile(mediaFile) ? mediaFile : null);

      const materialFile = mediaFile ?? imageFile;
      if (materialFile && options.pasteIntoSelectedUpload && targetNode?.type === CANVAS_NODE_TYPES.upload) {
        canvasEventBus.publish('upload-node/paste-material', {
          nodeId: targetNode.id,
          file: materialFile,
        });
        markSystemClipboardFresh();
        return true;
      }

      if (isPromptPasteTarget && targetNode) {
        if (imageFile) {
          const handled = await pasteMaterialAsNodeReference(imageFile, targetNode);
          if (handled) {
            markSystemClipboardFresh();
            return true;
          }
        }

        if (mediaFile && !imageFile) {
          const handled = await pasteMaterialAsNodeReference(mediaFile, targetNode);
          if (handled) {
            markSystemClipboardFresh();
            return true;
          }
        }

        if (pasteVideoSourceAsNodeReference(clipboardContent.text, targetNode)) {
          markSystemClipboardFresh();
          return true;
        }

        if (pasteTextIntoPromptNode(targetNode, clipboardContent.text)) {
          markSystemClipboardFresh();
          return true;
        }
      }

      if (isTextPasteTarget && targetNode && pasteTextIntoTextNode(targetNode, clipboardContent.text)) {
        markSystemClipboardFresh();
        return true;
      }

      if (materialFile) {
        const created = await materialImport.createFromFile(
          materialFile,
          options.flowPosition ?? resolvePastePosition()
        );
        if (options.flowPosition && !created) return false;
        markSystemClipboardFresh();
        return true;
      }

      if (pasteTextAsTextNode(clipboardContent.text, options.flowPosition)) {
        markSystemClipboardFresh();
        return true;
      }

      return false;
    },
    [
      materialImport,
      resolvePastePosition,
      markSystemClipboardFresh,
      pasteMaterialAsNodeReference,
      pasteTextAsTextNode,
      pasteTextIntoPromptNode,
      pasteTextIntoTextNode,
      pasteVideoSourceAsNodeReference,
    ]
  );
  const handleShortcutPaste = useCallback(async () => {
    const pasteSource = await resolveClipboardPasteSource();
    if (pasteSource.source === 'internal') {
      return Boolean(pasteCopiedNodes(resolvePastePosition()));
    }
    if (pasteSource.source !== 'system') {
      return false;
    }

    const selectedTargetNode = getSelectedTargetNode();
    return await pasteSystemClipboardContent(pasteSource.content, {
      targetNode: selectedTargetNode,
      flowPosition: resolvePastePosition(),
      pasteIntoSelectedUpload: selectedTargetNode?.type === CANVAS_NODE_TYPES.upload,
    });
  }, [
    pasteCopiedNodes,
    pasteSystemClipboardContent,
    resolveClipboardPasteSource,
    resolvePastePosition,
  ]);

  const pasteMediaFromClipboardEvent = useCallback(async (file: File) => {
    const selectedTargetNode = getSelectedTargetNode();
    await pasteSystemClipboardContent(
      {
        mediaFile: file,
        imageFile: isImageFile(file) ? file : null,
        text: '',
        fingerprint: `event-${resolveMediaFingerprintKind(file)}:${file.name}:${file.size}:${file.type}:${file.lastModified}`,
      },
      {
        targetNode: selectedTargetNode,
        pasteIntoSelectedUpload: selectedTargetNode?.type === CANVAS_NODE_TYPES.upload,
      }
    );
  }, [pasteSystemClipboardContent]);

  const pasteTextFromClipboardEvent = useCallback(async (text: string) => {
    const selectedTargetNode = getSelectedTargetNode();
    await pasteSystemClipboardContent(
      {
        mediaFile: null,
        imageFile: null,
        text,
        fingerprint: `event-text:${text.trim().length}:${hashText(text.trim())}`,
      },
      {
        targetNode: selectedTargetNode,
        flowPosition: resolvePastePosition(),
      }
    );
  }, [pasteSystemClipboardContent, resolvePastePosition]);

  const shouldHandleClipboardEventPaste = useCallback(async (payload: {
    mediaFile?: File | null;
    imageFile: File | null;
    text: string;
  }) => {
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    if (!internalSnapshotIsFresh) {
      return true;
    }

    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }

    if (settledInternalBaseline === undefined) {
      return false;
    }

    const eventFingerprint = payload.mediaFile
      ? await fingerprintMediaFile(payload.mediaFile)
      : payload.imageFile
        ? await fingerprintMediaFile(payload.imageFile)
      : fingerprintClipboardContent({ text: payload.text });
    return Boolean(eventFingerprint && eventFingerprint !== settledInternalBaseline);
  }, []);
  const pasteAt = useCallback(async (menuState: { nodeId: string | null; flowPosition: FlowPoint }) => {

    const targetNode = menuState.nodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === menuState.nodeId) ?? null
      : null;
    const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
      || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
      || targetNode?.type === CANVAS_NODE_TYPES.aiText;
    const pasteFlowPosition = targetNode && (
      targetNode.type === CANVAS_NODE_TYPES.upload
      || targetNode.type === CANVAS_NODE_TYPES.exportImage
      || targetNode.type === CANVAS_NODE_TYPES.video
      || targetNode.type === CANVAS_NODE_TYPES.audio
    )
      ? (() => {
          const nodeMap = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node] as const));
          const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
          const size = getNodeSize(targetNode);
          return {
            x: absolute.x + size.width + 80,
            y: absolute.y,
          };
        })()
      : menuState.flowPosition;

    const clipboardContent = await readClipboardContent({ avoidBrowserApiWhenTauriAvailable: true });
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (internalSnapshotIsFresh && settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }
    const clipboardHasPayload = hasClipboardPayload(clipboardContent);
    const clipboardReadCanConfirmEmpty = !clipboardContent.readFailed;
    const clipboardMatchesSettledInternalBaseline = internalSnapshotIsFresh
      && settledInternalBaseline !== undefined
      && clipboardContent.fingerprint === settledInternalBaseline;
    const clipboardCanConfirmSettledInternalBaseline = clipboardMatchesSettledInternalBaseline
      && (clipboardHasPayload || clipboardReadCanConfirmEmpty);
    if (clipboardHasPayload && !clipboardCanConfirmSettledInternalBaseline) {
      await pasteSystemClipboardContent(clipboardContent, {
        targetNode,
        flowPosition: pasteFlowPosition,
      });
      return;
    }
    if (clipboardContent.readFailed && !clipboardCanConfirmSettledInternalBaseline) {
      return;
    }

    if (internalSnapshotIsFresh) {
      pasteCopiedNodes(pasteFlowPosition);
      return;
    }

    if (!isPromptPasteTarget && clipboardFreshnessRef.current !== 'system') {
      pasteCopiedNodes(pasteFlowPosition);
    }
  }, [
    pasteCopiedNodes,
    pasteSystemClipboardContent,
  ]);

  usePasteBridge({
    pasteFromShortcut: handleShortcutPaste,
    markSystemClipboardFresh,
    shouldHandleClipboardEventPaste,
    pasteMediaFromClipboardEvent,
    pasteTextFromClipboardEvent,
  });

  // Stable identity: canvas actions (and every menu reading them) are built from this object.
  return useMemo(() => ({
    copyNodes: copyNodesToClipboard,
    duplicateNodes,
    pasteFromShortcut: handleShortcutPaste,
    pasteAt,
    copyText,
  }), [copyNodesToClipboard, copyText, duplicateNodes, handleShortcutPaste, pasteAt]);
}
