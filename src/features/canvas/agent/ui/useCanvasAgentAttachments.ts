import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  createAgentCanvasMediaInput,
  MAX_AGENT_MEDIA_ATTACHMENTS,
  validateAgentImageFile,
} from '../application/agentMediaResolver';
import type { AgentTurnMediaInput } from '../domain/agentModel';

export function useCanvasAgentAttachments(projectId: string) {
  const { t } = useTranslation();
  const canvasNodes = useCanvasStore((canvas) => canvas.nodes);
  const [attachments, setAttachments] = useState<AgentTurnMediaInput[]>([]);
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);
  const imageAssets = useMemo(
    () => buildCanvasAssetCatalog(canvasNodes).filter((asset) => asset.kind === 'image'),
    [canvasNodes],
  );
  const imageAssetIds = useMemo(() => new Set(imageAssets.map((asset) => asset.id)), [imageAssets]);
  const hasMissingAttachments = attachments.some((attachment) => (
    attachment.origin === 'canvas-asset' && !imageAssetIds.has(attachment.assetId)
  ));

  const reset = () => {
    setAttachments([]);
    setPickerOpen(false);
    setError(null);
  };

  useEffect(() => {
    reset();
  }, [projectId]);

  const toggle = (asset: (typeof imageAssets)[number]) => {
    setError(null);
    setAttachments((current) => {
      const exists = current.some((attachment) => attachment.assetId === asset.id);
      if (exists) return current.filter((attachment) => attachment.assetId !== asset.id);
      if (current.length >= MAX_AGENT_MEDIA_ATTACHMENTS) return current;
      return [...current, createAgentCanvasMediaInput(asset)];
    });
  };

  const attachSelectedNode = (selectedNodeId: string | null) => {
    if (!selectedNodeId) return;
    const asset = imageAssets
      .filter((candidate) => candidate.nodeId === selectedNodeId)
      .sort((left, right) => right.order - left.order)
      .find((candidate) => !attachments.some((attachment) => attachment.assetId === candidate.id));
    if (!asset) {
      setError(t('canvasAgent.noImageOnSelection'));
      return;
    }
    toggle(asset);
  };

  const upload = async (files: File[]) => {
    const remaining = MAX_AGENT_MEDIA_ATTACHMENTS - attachments.length;
    if (files.length > remaining) {
      setError(t('canvasAgent.tooManyAttachmentsSelected', { count: files.length, remaining }));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      for (const [index, file] of files.entries()) {
        await validateAgentImageFile(file);
        const prepared = await prepareNodeImageFromFile(file);
        const canvas = useCanvasStore.getState();
        const zoom = Math.max(0.01, canvas.currentViewport.zoom);
        const position = {
          x: (canvas.canvasViewportSize.width / 2 - canvas.currentViewport.x) / zoom + index * 28,
          y: (canvas.canvasViewportSize.height / 2 - canvas.currentViewport.y) / zoom + index * 28,
        };
        const nodeId = canvas.addNode(CANVAS_NODE_TYPES.upload, position, {
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: file.name,
          displayName: file.name,
        });
        const latestCanvas = useCanvasStore.getState();
        const projectStore = useProjectStore.getState();
        if (projectStore.currentProjectId === projectId) {
          projectStore.saveCurrentProject(
            latestCanvas.nodes,
            latestCanvas.edges,
            latestCanvas.currentViewport,
            latestCanvas.history,
          );
        }
        const asset = buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
          .find((candidate) => candidate.id === `${nodeId}:image`);
        if (!asset) throw new Error(t('canvasAgent.uploadAttachmentFailed'));
        const attachment = createAgentCanvasMediaInput(asset);
        setAttachments((current) => current.some((item) => item.assetId === attachment.assetId)
          ? current
          : [...current, attachment].slice(0, MAX_AGENT_MEDIA_ATTACHMENTS));
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
    }
  };

  return {
    attachments,
    imageAssets,
    maxAttachments: MAX_AGENT_MEDIA_ATTACHMENTS,
    hasMissingAttachments,
    isPickerOpen,
    isUploading,
    error,
    reset,
    toggle,
    attachSelectedNode,
    upload,
    openPicker: () => {
      setError(null);
      setPickerOpen((open) => !open);
    },
    closePicker: () => {
      setPickerOpen(false);
      setError(null);
    },
    remove: (assetId: string) => {
      setAttachments((current) => current.filter((attachment) => attachment.assetId !== assetId));
      setError(null);
    },
    setError,
  };
}
