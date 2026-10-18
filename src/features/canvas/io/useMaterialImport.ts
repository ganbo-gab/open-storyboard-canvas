import { useCallback, useEffect, type DragEvent as ReactDragEvent } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { prepareNodeImage, prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { prepareVideoNodeDataFromFile, prepareVideoNodeDataFromSource } from '@/features/canvas/application/videoUpload';
import { prepareAudioNodeDataFromFile, prepareAudioNodeDataFromSource } from '@/features/canvas/application/audioUpload';
import {
  dataTransferHasExternalFilePayload,
  dataTransferHasMaterialFile,
  inferMaterialFileKind,
  resolveDroppedMaterialFile,
  resolveDroppedMaterialSource,
  type DroppedMaterialKind,
  type DroppedMaterialSource,
} from '@/features/canvas/application/imageDragDrop';

export interface CreatedMaterialNode {
  nodeId: string;
  type: CanvasNodeType;
}

export interface MaterialImportApi {
  /** Import a media file, select the new node, and persist it. */
  createFromFile(file: File, flowPosition: FlowPoint): Promise<CreatedMaterialNode | null>;
  /** Import a dropped or pasted URL/path source. */
  createFromSource(material: DroppedMaterialSource, flowPosition: FlowPoint): Promise<CreatedMaterialNode | null>;
  handleDragOver(event: ReactDragEvent<HTMLElement>): void;
  handleDrop(event: ReactDragEvent<HTMLElement>): void;
}

type MaterialInput = { file: File } | { source: string; fileName: string | null };

interface MaterialAdapter {
  type: CanvasNodeType;
  prepare(input: MaterialInput): Promise<Partial<CanvasNodeData>>;
}

const MATERIAL_ADAPTERS: Record<DroppedMaterialKind, MaterialAdapter> = {
  image: {
    type: CANVAS_NODE_TYPES.upload,
    async prepare(input) {
      const prepared = 'file' in input
        ? await prepareNodeImageFromFile(input.file)
        : await prepareNodeImage(input.source);
      return {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio || '1:1',
        sourceFileName: 'file' in input ? input.file.name : input.fileName,
      };
    },
  },
  video: {
    type: CANVAS_NODE_TYPES.video,
    prepare: (input) => 'file' in input
      ? prepareVideoNodeDataFromFile(input.file)
      : prepareVideoNodeDataFromSource(input.source, input.fileName),
  },
  audio: {
    type: CANVAS_NODE_TYPES.audio,
    prepare: (input) => 'file' in input
      ? prepareAudioNodeDataFromFile(input.file)
      : prepareAudioNodeDataFromSource(input.source, input.fileName),
  },
};

export function useMaterialImport(options: {
  screenToFlowPosition: (point: { x: number; y: number }) => FlowPoint;
  scheduleCanvasPersist: (delayMs?: number) => void;
}): MaterialImportApi {
  const { screenToFlowPosition, scheduleCanvasPersist } = options;

  const createMaterial = useCallback(async (
    kind: DroppedMaterialKind,
    input: MaterialInput,
    flowPosition: FlowPoint
  ): Promise<CreatedMaterialNode | null> => {
    try {
      const adapter = MATERIAL_ADAPTERS[kind];
      const nodeData = await adapter.prepare(input);
      const fileName = 'file' in input ? input.file.name : input.fileName;
      if (useSettingsStore.getState().useUploadFilenameAsNodeTitle && fileName) {
        nodeData.displayName = fileName;
      }
      const nodeId = useCanvasStore.getState().addNode(adapter.type, flowPosition, nodeData);
      useCanvasStore.getState().setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
      return { nodeId, type: adapter.type };
    } catch (error) {
      console.error(`Failed to import ${kind}${'file' in input ? '' : ' source'} onto canvas`, error);
      return null;
    }
  }, [scheduleCanvasPersist]);

  const createFromFile = useCallback(async (file: File, flowPosition: FlowPoint) => {
    const kind = inferMaterialFileKind(file);
    if (!kind) {
      console.warn('Unsupported material file dropped onto canvas', file.type, file.name);
      return null;
    }
    return createMaterial(kind, { file }, flowPosition);
  }, [createMaterial]);

  const createFromSource = useCallback((material: DroppedMaterialSource, flowPosition: FlowPoint) => (
    createMaterial(material.kind, { source: material.source, fileName: material.fileName }, flowPosition)
  ), [createMaterial]);

  useEffect(() => {
    const handleWindowFileDragOver = (event: DragEvent) => {
      if (!dataTransferHasExternalFilePayload(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = (
          dataTransferHasMaterialFile(event.dataTransfer)
          || dataTransferHasExternalFilePayload(event.dataTransfer)
        ) ? 'copy' : 'none';
      }
    };
    const handleWindowFileDrop = (event: DragEvent) => {
      if (dataTransferHasExternalFilePayload(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener('dragover', handleWindowFileDragOver, true);
    window.addEventListener('drop', handleWindowFileDrop, true);
    document.addEventListener('dragover', handleWindowFileDragOver, true);
    document.addEventListener('drop', handleWindowFileDrop, true);
    return () => {
      window.removeEventListener('dragover', handleWindowFileDragOver, true);
      window.removeEventListener('drop', handleWindowFileDrop, true);
      document.removeEventListener('dragover', handleWindowFileDragOver, true);
      document.removeEventListener('drop', handleWindowFileDrop, true);
    };
  }, []);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!dataTransferHasExternalFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = (
      dataTransferHasMaterialFile(event.dataTransfer)
      || dataTransferHasExternalFilePayload(event.dataTransfer)
    ) ? 'copy' : 'none';
  }, []);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!dataTransferHasExternalFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const file = resolveDroppedMaterialFile(event.dataTransfer);
    if (file) {
      void createFromFile(file, flowPosition);
      return;
    }
    const material = resolveDroppedMaterialSource(event.dataTransfer);
    if (material) void createFromSource(material, flowPosition);
  }, [createFromFile, createFromSource, screenToFlowPosition]);

  return { createFromFile, createFromSource, handleDragOver, handleDrop };
}
