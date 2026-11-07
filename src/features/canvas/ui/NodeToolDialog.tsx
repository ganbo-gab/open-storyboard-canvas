import { lazy, Suspense, useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  NODE_TOOL_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasEventBus,
  canvasToolProcessor,
} from '@/features/canvas/application/canvasServices';
import { prepareNodeImage, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { readStoryboardImageMetadata } from '@/commands/image';
import { getToolPlugin, type ToolOptions } from '@/features/canvas/tools';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiButton, UiModal } from '@/components/ui';
import { UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { FormToolEditor } from './tool-editors/FormToolEditor';
import { CropToolEditor } from './tool-editors/CropToolEditor';
// Lazy-load the Konva-heavy annotate editor (~300 KB minified). It's
// only mounted when the user opens the annotation tool dialog, so
// there's no value in shipping it on cold start.
const AnnotateToolEditor = lazy(() =>
  import('./tool-editors/AnnotateToolEditor').then((m) => ({ default: m.AnnotateToolEditor })),
);
import { SplitStoryboardToolEditor } from './tool-editors/SplitStoryboardToolEditor';
import { MaskToolEditor } from './tool-editors/MaskToolEditor';

export function NodeToolDialog() {
  const { t } = useTranslation();
  const activeToolDialog = useCanvasStore((state) => state.activeToolDialog);
  const nodes = useCanvasStore((state) => state.nodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addStoryboardSplitNode = useCanvasStore((state) => state.addStoryboardSplitNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ToolOptions>({});
  const [isSplitImageReady, setIsSplitImageReady] = useState(true);
  const [displayToolDialog, setDisplayToolDialog] = useState(activeToolDialog);

  useEffect(() => {
    if (activeToolDialog) {
      setDisplayToolDialog(activeToolDialog);
      return;
    }

    const timer = setTimeout(() => {
      setDisplayToolDialog(null);
    }, UI_DIALOG_TRANSITION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [activeToolDialog]);

  const sourceNode = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return nodes.find((node) => node.id === displayToolDialog.nodeId) ?? null;
  }, [displayToolDialog, nodes]);

  const sourceImageUrl = useMemo(() => {
    if (!sourceNode) {
      return null;
    }

    if (isUploadNode(sourceNode) || isImageEditNode(sourceNode) || isExportImageNode(sourceNode)) {
      return sourceNode.data.imageUrl;
    }

    return null;
  }, [sourceNode]);

  const activePlugin = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return getToolPlugin(displayToolDialog.toolType);
  }, [displayToolDialog]);

  const dialogKey = displayToolDialog
    ? `${displayToolDialog.nodeId}:${displayToolDialog.toolType}`
    : null;

  useEffect(() => {
    if (!sourceNode || !activePlugin) {
      return;
    }

    let cancelled = false;
    setError(null);
    // Tool plugins ship a default options bag (e.g. splitStoryboard ships
    // 3x3). When the dialog is opened with explicit overrides — typically
    // from GridSplitPanel after the user picked 2x2 / 4x4 / a custom
    // grid — merge those on top so the dialog opens already pointing at
    // the user's choice instead of the plugin default.
    const baseOptions = activePlugin.createInitialOptions(sourceNode);
    const initialOptions: ToolOptions = displayToolDialog?.initialOptionsOverride
      ? ({ ...baseOptions, ...displayToolDialog.initialOptionsOverride } as ToolOptions)
      : baseOptions;
    setOptions(initialOptions);

    if (activePlugin.editor !== 'split' || !sourceImageUrl) {
      return () => {
        cancelled = true;
      };
    }

    // For split-storyboard, the source image may carry embedded metadata
    // about the grid it was generated from. If the caller passed an
    // explicit override (the user just clicked a grid preset) we honor
    // that — overrides win over metadata. Otherwise fall back to the
    // metadata so reopening a previously-split image lands on its
    // original grid.
    if (displayToolDialog?.initialOptionsOverride) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const metadata = await readStoryboardImageMetadata(sourceImageUrl);
        if (!metadata || cancelled) {
          return;
        }

        const nextRows = Math.max(1, Math.min(8, Math.floor(metadata.gridRows)));
        const nextCols = Math.max(1, Math.min(8, Math.floor(metadata.gridCols)));
        if (!Number.isFinite(nextRows) || !Number.isFinite(nextCols)) {
          return;
        }

        setOptions((previous) => ({
          ...previous,
          rows: nextRows,
          cols: nextCols,
        }));
      } catch (error) {
        console.warn('[StoryboardMetadata] read failed on split dialog init', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dialogKey, sourceNode, activePlugin, sourceImageUrl, displayToolDialog?.initialOptionsOverride]);

  useEffect(() => {
    const requiresSplitPreload = activePlugin?.editor === 'split' && Boolean(sourceImageUrl);
    if (!requiresSplitPreload || !sourceImageUrl) {
      setIsSplitImageReady(true);
      return;
    }

    let cancelled = false;
    const image = new Image();
    const displayImageUrl = resolveImageDisplayUrl(sourceImageUrl);

    setIsSplitImageReady(false);

    image.onload = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.onerror = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.src = displayImageUrl;
    if (image.complete) {
      setIsSplitImageReady(true);
    }

    return () => {
      cancelled = true;
    };
  }, [activePlugin?.editor, sourceImageUrl]);

  const closeDialog = useCallback(() => {
    canvasEventBus.publish('tool-dialog/close', undefined);
  }, []);

  const isAsyncAiEditTool = useCallback((toolType: NodeToolType | undefined) => (
    toolType === NODE_TOOL_TYPES.hd
    || toolType === NODE_TOOL_TYPES.outpainting
    || toolType === NODE_TOOL_TYPES.inpainting
    || toolType === NODE_TOOL_TYPES.erase
    || toolType === NODE_TOOL_TYPES.matting
  ), []);

  const resolveToolLabel = useCallback((toolType: NodeToolType | undefined) => {
    if (!toolType) {
      return '';
    }
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    if (toolType === NODE_TOOL_TYPES.hd) {
      return '高清';
    }
    if (toolType === NODE_TOOL_TYPES.outpainting) {
      return '扩图';
    }
    if (toolType === NODE_TOOL_TYPES.inpainting) {
      return '重绘';
    }
    if (toolType === NODE_TOOL_TYPES.erase) {
      return '擦除';
    }
    if (toolType === NODE_TOOL_TYPES.matting) {
      return '抠图';
    }
    return '';
  }, [t]);
  const resolveResultNodeTitle = useCallback((toolType: NodeToolType | undefined) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('toolDialog.cropResultTitle');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('toolDialog.annotateResultTitle');
    }
    if (toolType === NODE_TOOL_TYPES.hd) {
      return '高清结果';
    }
    if (toolType === NODE_TOOL_TYPES.outpainting) {
      return '扩图结果';
    }
    if (toolType === NODE_TOOL_TYPES.inpainting) {
      return '重绘结果';
    }
    if (toolType === NODE_TOOL_TYPES.erase) {
      return '擦除结果';
    }
    if (toolType === NODE_TOOL_TYPES.matting) {
      return '抠图结果';
    }
    return EXPORT_RESULT_DISPLAY_NAME.generic;
  }, [t]);

  const handleApply = useCallback(async () => {
    if (!activeToolDialog || !sourceNode || !sourceImageUrl || !activePlugin) {
      setError(t('toolDialog.noProcessableImage'));
      return;
    }

    setIsProcessing(true);
    setError(null);

    if (isAsyncAiEditTool(activeToolDialog.toolType)) {
      const newNodePosition = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, newNodePosition, {
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio: sourceNode.data.aspectRatio ?? '1:1',
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationDurationMs: 60000,
        resultKind: 'generic',
        displayName: resolveResultNodeTitle(activeToolDialog.toolType),
      });
      addEdge(sourceNode.id, newNodeId, { provenance: 'generationResult' });
      closeDialog();
      setIsProcessing(false);

      void (async () => {
        try {
          const result = await activePlugin.execute(sourceImageUrl, options, {
            processTool: (toolType, imageUrl, toolOptions) =>
              canvasToolProcessor.process(toolType, imageUrl, toolOptions),
          });

          if (!result.outputImageUrl) {
            throw new Error(t('toolDialog.processFailed'));
          }

          const prepared = await prepareNodeImage(result.outputImageUrl);
          updateNodeData(newNodeId, {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            aspectRatio: prepared.aspectRatio,
            isGenerating: false,
            generationStartedAt: null,
            generationJobId: null,
            generationProviderId: null,
            generationClientSessionId: null,
            generationError: null,
            generationErrorDetails: null,
          });
        } catch (processError) {
          updateNodeData(newNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationJobId: null,
            generationProviderId: null,
            generationClientSessionId: null,
            generationError: processError instanceof Error ? processError.message : t('toolDialog.processFailed'),
            generationErrorDetails: null,
          });
        }
      })();
      return;
    }

    try {
      const result = await activePlugin.execute(sourceImageUrl, options, {
        processTool: (toolType, imageUrl, toolOptions) =>
          canvasToolProcessor.process(toolType, imageUrl, toolOptions),
      });

      if (result.storyboardFrames && result.rows && result.cols) {
        const createdNodeId = addStoryboardSplitNode(
          sourceNode.id,
          result.rows,
          result.cols,
          result.storyboardFrames,
          result.frameAspectRatio
        );
        if (createdNodeId) {
          addEdge(sourceNode.id, createdNodeId, { provenance: 'generationResult' });
        }
      } else if (result.outputImageUrl) {
        const prepared = await prepareNodeImage(result.outputImageUrl);
        const createdNodeId = addDerivedExportNode(
          sourceNode.id,
          prepared.imageUrl,
          prepared.aspectRatio,
          prepared.previewImageUrl,
          {
            defaultTitle: resolveResultNodeTitle(activeToolDialog.toolType),
            resultKind: 'generic',
            aspectRatioStrategy: 'provided',
            sizeStrategy: 'autoMinEdge',
          }
        );
        if (createdNodeId) {
          addEdge(sourceNode.id, createdNodeId, { provenance: 'generationResult' });
        }
      }

      closeDialog();
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : t('toolDialog.processFailed'));
    } finally {
      setIsProcessing(false);
    }
  }, [
    activeToolDialog,
    sourceNode,
    sourceImageUrl,
    activePlugin,
    options,
    addNode,
    addStoryboardSplitNode,
    addDerivedExportNode,
    addEdge,
    findNodePosition,
    updateNodeData,
    closeDialog,
    isAsyncAiEditTool,
    resolveResultNodeTitle,
    t,
  ]);

  const widthClassName = useMemo(() => {
    if (!activePlugin) {
      return 'w-[min(460px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'crop') {
      return 'w-[min(980px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'annotate') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'split') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    return 'w-[min(460px,calc(100vw-40px))]';
  }, [activePlugin]);

  const editorContent = useMemo(() => {
    if (!activePlugin) {
      return null;
    }

    if (activePlugin.editor === 'crop' && sourceImageUrl) {
      return (
        <CropToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    if (activePlugin.editor === 'annotate' && sourceImageUrl) {
      return (
        <Suspense fallback={<div className="p-6 text-sm text-text-muted">正在加载标注编辑器…</div>}>
          <AnnotateToolEditor
            plugin={activePlugin}
            sourceImageUrl={sourceImageUrl}
            options={options}
            onOptionsChange={setOptions}
          />
        </Suspense>
      );
    }

    if (activePlugin.editor === 'split' && sourceImageUrl) {
      return (
        <SplitStoryboardToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    if (activePlugin.editor === 'mask' && sourceImageUrl) {
      return (
        <MaskToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    return (
      <FormToolEditor
        plugin={activePlugin}
        fields={activePlugin.fields}
        options={options}
        onOptionsChange={setOptions}
      />
    );
  }, [activePlugin, options, sourceImageUrl]);

  const isOpen = Boolean(activeToolDialog && isSplitImageReady);

  return (
    <UiModal
      isOpen={isOpen}
      title={`${resolveToolLabel(activePlugin?.type)}${t('toolDialog.suffix')}`}
      onClose={closeDialog}
      widthClassName={widthClassName}
      footer={
        <>
          <UiButton variant="ghost" size="sm" onClick={closeDialog}>
            {t('common.cancel')}
          </UiButton>
          <UiButton size="sm" variant="primary" onClick={handleApply} disabled={isProcessing || !sourceImageUrl}>
            {isProcessing ? t('toolDialog.processing') : t('toolDialog.apply')}
          </UiButton>
        </>
      }
    >
      <div className="space-y-3 max-h-[82vh] overflow-y-auto pr-1">
        {editorContent}
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
    </UiModal>
  );
}
