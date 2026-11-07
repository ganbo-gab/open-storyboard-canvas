import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeProps } from '@xyflow/react';
import { Camera, Grid3x3, Loader2, Maximize2, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Viewer } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  getPanoramaControlSensitivityMultiplier,
  useSettingsStore,
  type PanoramaControlSensitivity,
} from '@/stores/settingsStore';
import { CANVAS_NODE_TYPES, type PanoramaNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeFrame, type NodeFrameStatus } from '@/features/canvas/ui/NodeFrame';
import { GenerationReferenceRetry } from '@/features/canvas/ui/GenerationReferenceRetry';
import { UiIconButton } from '@/components/ui';
import {
  normalizePanoramaToDataUrl,
  type PanoramaProjection,
} from '@/features/canvas/application/panoramaNormalize';
import { PanoramaSetupForm } from '@/features/canvas/ui/PanoramaSetupForm';
import type { PanoramaGenerateConfig } from '@/features/canvas/ui/PanoramaPanel';
import {
  parseInputImageSignature,
  selectInputImageSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import { submitNodeGeneration } from '@/features/canvas/application/generation';
import { imageUrlToDataUrl, reduceAspectRatio, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { persistImageSource } from '@/commands/image';

type PanoramaNodeProps = NodeProps & {
  data: PanoramaNodeData & { projection?: PanoramaProjection };
};

interface PanoramaViewerSurfaceProps {
  normalizedUrl: string | null;
  normalizing: boolean;
  viewerError: string | null;
  projection: PanoramaProjection;
  initialYaw?: number | null;
  initialPitch?: number | null;
  initialFov?: number | null;
  useLegacyControlDirection: boolean;
  controlSensitivity: PanoramaControlSensitivity;
  className?: string;
  onExpand?: () => void;
  onCaptureCurrent: (imageUrl: string, aspectRatio: string) => void | Promise<void>;
  onCaptureQuad: (imageUrl: string, aspectRatio: string) => void | Promise<void>;
  onClose: () => void;
  closeLabel: string;
  expanded?: boolean;
}

const PANORAMA_KEY_STEP = 4 * (Math.PI / 180);
const PANORAMA_CAPTURE_RENDER_TIMEOUT_MS = 600;
const PANORAMA_CAPTURE_SAMPLE_SIZE = 16;
const PANORAMA_VIEWER_BUTTON_CLASS =
  'group relative h-11 w-11 rounded-lg border border-[var(--line-strong)] bg-elevated/95 text-text-dark shadow-[var(--shadow-pop)] backdrop-blur-xs';

function getViewerCanvas(viewer: Viewer | null): HTMLCanvasElement | null {
  if (!viewer) return null;
  return (viewer as unknown as { renderer?: { renderer?: { domElement?: HTMLCanvasElement } } }).renderer?.renderer?.domElement ?? null;
}

function waitForViewerRender(viewer: Viewer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    function handleRender() {
      finish();
    }
    function finish() {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      viewer.removeEventListener('render', handleRender);
      resolve();
    }

    viewer.addEventListener('render', handleRender);
    timeoutId = window.setTimeout(finish, PANORAMA_CAPTURE_RENDER_TIMEOUT_MS);
    viewer.needsUpdate();
  });
}

function assertCanvasHasCaptureContent(canvas: HTMLCanvasElement): void {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('Panorama capture canvas is empty.');
  }

  const sample = document.createElement('canvas');
  sample.width = PANORAMA_CAPTURE_SAMPLE_SIZE;
  sample.height = PANORAMA_CAPTURE_SAMPLE_SIZE;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Panorama capture validation failed.');
  }

  ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
  let maxAlpha = 0;
  let maxColor = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    maxColor = Math.max(maxColor, pixels[i], pixels[i + 1], pixels[i + 2]);
    maxAlpha = Math.max(maxAlpha, pixels[i + 3]);
  }

  if (maxAlpha <= 2 || maxColor <= 2) {
    throw new Error('Panorama capture is blank.');
  }
}

async function captureViewerCanvas(viewer: Viewer | null): Promise<HTMLCanvasElement> {
  if (!viewer) {
    throw new Error('Panorama viewer is not ready.');
  }

  await waitForViewerRender(viewer);
  const canvas = getViewerCanvas(viewer);
  if (!canvas) {
    throw new Error('Panorama viewer canvas is not available.');
  }
  assertCanvasHasCaptureContent(canvas);
  return canvas;
}

const PanoramaViewerSurface = memo(({
  normalizedUrl,
  normalizing,
  viewerError,
  projection,
  initialYaw,
  initialPitch,
  initialFov,
  useLegacyControlDirection,
  controlSensitivity,
  className,
  onExpand,
  onCaptureCurrent,
  onCaptureQuad,
  onClose,
  closeLabel,
  expanded = false,
}: PanoramaViewerSurfaceProps) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [localViewerError, setLocalViewerError] = useState<string | null>(null);

  useEffect(() => {
    if (!normalizedUrl) setLocalViewerError(null);
  }, [normalizedUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !normalizedUrl) return;

    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }

    let viewer: Viewer;
    const sensitivityMultiplier = getPanoramaControlSensitivityMultiplier(controlSensitivity);
    const controlDirection = useLegacyControlDirection ? 1 : -1;
    try {
      viewer = new Viewer({
        container,
        panorama: normalizedUrl,
        defaultYaw: initialYaw ?? 0,
        defaultPitch: initialPitch ?? 0,
        defaultZoomLvl: typeof initialFov === 'number' ? initialFov : 50,
        minFov: 25,
        maxFov: 110,
        navbar: false,
        mousewheel: true,
        touchmoveTwoFingers: false,
        moveInertia: false,
        mousemove: expanded,
        moveSpeed: controlDirection * sensitivityMultiplier,
        // The export buttons read the WebGL canvas after Photo Sphere Viewer renders.
        rendererParameters: { preserveDrawingBuffer: true },
      });
      setLocalViewerError(null);
    } catch {
      setLocalViewerError(t('node.panoramaViewer.loadFailed'));
      return;
    }
    viewerRef.current = viewer;

    container.style.opacity = '0';
    container.style.transition = 'opacity 320ms ease';
    const fadeIn = () => { container.style.opacity = '1'; };
    viewer.addEventListener('ready', fadeIn as unknown as EventListener);

    const focusContainer = () => {
      container.focus({ preventScroll: true });
    };
    const setPointerMovementEnabled = (enabled: boolean) => {
      viewer.setOptions({ mousemove: enabled });
    };
    const handlePointerEnter = () => {
      focusContainer();
      setPointerMovementEnabled(true);
    };
    const handlePointerLeave = () => {
      if (!expanded) {
        setPointerMovementEnabled(false);
      }
    };
    const handleUserInput = () => {
      focusContainer();
      if (!expanded) {
        setPointerMovementEnabled(true);
      }
    };
    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
      handleUserInput();
    };
    const handleWindowPointerUp = () => {
      if (!expanded && !container.matches(':hover')) {
        setPointerMovementEnabled(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      const pos = viewer.getPosition();
      const keyStep = PANORAMA_KEY_STEP * sensitivityMultiplier * controlDirection;
      if (event.key === 'ArrowLeft') {
        viewer.rotate({ yaw: pos.yaw - keyStep, pitch: pos.pitch });
      } else if (event.key === 'ArrowRight') {
        viewer.rotate({ yaw: pos.yaw + keyStep, pitch: pos.pitch });
      } else if (event.key === 'ArrowUp') {
        viewer.rotate({ yaw: pos.yaw, pitch: pos.pitch + keyStep });
      } else if (event.key === 'ArrowDown') {
        viewer.rotate({ yaw: pos.yaw, pitch: pos.pitch - keyStep });
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener('pointerleave', handlePointerLeave);
    container.addEventListener('pointerenter', handlePointerEnter);
    container.addEventListener('pointerdown', handleUserInput);
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('keydown', handleKey);
    window.addEventListener('pointerup', handleWindowPointerUp, true);
    window.addEventListener('pointercancel', handleWindowPointerUp, true);
    if (expanded) {
      requestAnimationFrame(focusContainer);
    }

    return () => {
      viewer.removeEventListener('ready', fadeIn as unknown as EventListener);
      container.removeEventListener('pointerleave', handlePointerLeave);
      container.removeEventListener('pointerenter', handlePointerEnter);
      container.removeEventListener('pointerdown', handleUserInput);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('keydown', handleKey);
      window.removeEventListener('pointerup', handleWindowPointerUp, true);
      window.removeEventListener('pointercancel', handleWindowPointerUp, true);
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [
    controlSensitivity,
    expanded,
    initialFov,
    initialPitch,
    initialYaw,
    normalizedUrl,
    t,
    useLegacyControlDirection,
  ]);

  const handleScreenshot = useCallback(async () => {
    try {
      const canvas = await captureViewerCanvas(viewerRef.current);
      const dataUrl = canvas.toDataURL('image/png');
      await onCaptureCurrent(dataUrl, reduceAspectRatio(canvas.width, canvas.height));
    } catch {
      await showErrorDialog(t('node.panoramaViewer.captureFailed'), t('common.error'));
    }
  }, [onCaptureCurrent, t]);

  const handleExportQuad = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const originalPosition = viewer.getPosition();
    try {
      const off = document.createElement('canvas');
      off.width = 2048;
      off.height = 2048;
      const ctx = off.getContext('2d');
      if (!ctx) {
        throw new Error('Panorama quad export canvas failed.');
      }
      const yaws = [0, 90, 180, 270];
      for (let i = 0; i < yaws.length; i++) {
        viewer.rotate({ yaw: yaws[i] * (Math.PI / 180), pitch: 0 });
        const canvas = await captureViewerCanvas(viewer);
        const row = Math.floor(i / 2);
        const col = i % 2;
        ctx.drawImage(canvas, col * 1024, row * 1024, 1024, 1024);
      }
      ctx.font = 'bold 36px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 4;
      const labels = ['前 (0°)', '右 (90°)', '后 (180°)', '左 (270°)'];
      for (let i = 0; i < labels.length; i++) {
        const row = Math.floor(i / 2);
        const col = i % 2;
        const x = col * 1024 + 24;
        const y = row * 1024 + 56;
        ctx.strokeText(labels[i], x, y);
        ctx.fillText(labels[i], x, y);
      }
      const dataUrl = off.toDataURL('image/png');
      await onCaptureQuad(dataUrl, reduceAspectRatio(off.width, off.height));
    } catch {
      await showErrorDialog(t('node.panoramaViewer.captureFailed'), t('common.error'));
    } finally {
      viewer.rotate(originalPosition);
      void waitForViewerRender(viewer);
    }
  }, [onCaptureQuad, t]);

  const handleResetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.rotate({ yaw: initialYaw ?? 0, pitch: initialPitch ?? 0 });
    viewer.zoom(typeof initialFov === 'number' ? initialFov : 50);
  }, [initialFov, initialPitch, initialYaw]);

  return (
    <div className={`nodrag nopan nowheel relative ${className ?? ''}`}>
      <div ref={containerRef} className="nodrag nopan nowheel w-full h-full focus-visible:outline-offset-[-2px]" tabIndex={0} />
      {normalizing && (
        <div className="absolute inset-0 flex items-center justify-center bg-(--canvas-node-media-overlay) text-white/85 text-xs">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('node.panoramaViewer.loading')}
        </div>
      )}
      {viewerError && (
        <div className="absolute inset-0 flex items-center justify-center bg-(--canvas-node-media-overlay) px-6 text-center text-xs leading-5 text-white/90">
          {viewerError}
        </div>
      )}
      {!viewerError && localViewerError && (
        <div className="absolute inset-0 flex items-center justify-center bg-(--canvas-node-media-overlay) px-6 text-center text-xs leading-5 text-white/90">
          {localViewerError}
        </div>
      )}
      <div className="absolute top-2.5 right-2.5 flex gap-1.5">
        {onExpand && (
          <UiIconButton type="button" onClick={(e) => { e.stopPropagation(); onExpand(); }} className={PANORAMA_VIEWER_BUTTON_CLASS} aria-label={t('node.panoramaViewer.expand')} title={t('node.panoramaViewer.expand')}>
            <Maximize2 className="w-4 h-4" />
            <span className="pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-text-dark shadow-(--shadow-pop) opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">{t('node.panoramaViewer.expand')}</span>
          </UiIconButton>
        )}
        <UiIconButton type="button" onClick={(e) => { e.stopPropagation(); void handleScreenshot(); }} className={PANORAMA_VIEWER_BUTTON_CLASS} aria-label={t('node.panoramaViewer.screenshot')} title={t('node.panoramaViewer.screenshot')}>
          <Camera className="w-4 h-4" />
          <span className="pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-text-dark shadow-(--shadow-pop) opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">{t('node.panoramaViewer.screenshot')}</span>
        </UiIconButton>
        <UiIconButton type="button" onClick={(e) => { e.stopPropagation(); void handleExportQuad(); }} className={PANORAMA_VIEWER_BUTTON_CLASS} aria-label={t('node.panoramaViewer.quad')} title={t('node.panoramaViewer.quad')}>
          <Grid3x3 className="w-4 h-4" />
          <span className="pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-text-dark shadow-(--shadow-pop) opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">{t('node.panoramaViewer.quad')}</span>
        </UiIconButton>
        <UiIconButton type="button" onClick={(e) => { e.stopPropagation(); handleResetView(); }} className={PANORAMA_VIEWER_BUTTON_CLASS} aria-label={t('node.panoramaViewer.reset')} title={t('node.panoramaViewer.reset')}>
          <RotateCcw className="w-4 h-4" />
          <span className="pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-text-dark shadow-(--shadow-pop) opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">{t('node.panoramaViewer.reset')}</span>
        </UiIconButton>
        <UiIconButton type="button" onClick={(e) => { e.stopPropagation(); onClose(); }} className={PANORAMA_VIEWER_BUTTON_CLASS} aria-label={closeLabel} title={closeLabel}>
          <X className="w-4 h-4" />
          <span className="pointer-events-none absolute top-full mt-2 right-0 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-text-dark shadow-(--shadow-pop) opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">{closeLabel}</span>
        </UiIconButton>
      </div>
      <div className="absolute bottom-2 left-2 text-[10px] text-white/70 bg-(--canvas-node-media-overlay) px-2 py-0.5 rounded-sm backdrop-blur-xs pointer-events-none">
        {projection === 'spherical' ? t('node.panoramaViewer.spherical') : t('node.panoramaViewer.cylindrical')} · {t('node.panoramaViewer.controlsHint')}
      </div>
    </div>
  );
});

PanoramaViewerSurface.displayName = 'PanoramaViewerSurface';

/**
 * Panorama node. Renders a 360°/720° panorama using photo-sphere-viewer after
 * frontend-normalizing the raw Dreamina output (typically 21:9) into 2:1 or 4:1.
 * Top-right toolbar sits outside the WebGL canvas so screenshot/quad-export
 * capture the scene only, not the UI.
 */
export const PanoramaNode = memo(({ id, data, selected, width, height }: PanoramaNodeProps) => {
  const { t } = useTranslation();
  const [normalizedUrl, setNormalizedUrl] = useState<string | null>(null);
  const [normalizing, setNormalizing] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const deleteNode = useCanvasStore((s) => s.deleteNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const addDerivedExportNode = useCanvasStore((s) => s.addDerivedExportNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const upstreamImageSignature = useCanvasStore((s) =>
    selectInputImageSignature(id, s.nodes, s.edges)
  );
  const useLegacyControlDirection = useSettingsStore((s) => s.useLegacyPanoramaControlDirection);
  const panoramaControlSensitivity = useSettingsStore((s) => s.panoramaControlSensitivity);

  const imageUrl = data.imageUrl ?? null;
  const displayImageUrl = useMemo(
    () => (imageUrl ? resolveImageDisplayUrl(imageUrl) : null),
    [imageUrl]
  );
  const projection: PanoramaProjection = data.projection ?? 'spherical';

  // Upstream images connected via the left handle — used both as the source
  // of the "图片扩展成全景" preview hint AND (when user submits in image
  // mode) as the reference stack.
  const upstreamImages = useMemo(
    () => parseInputImageSignature(upstreamImageSignature),
    [upstreamImageSignature]
  );
  const firstUpstreamImage = upstreamImages[0] ?? null;
  const previewImageUrl = firstUpstreamImage ? resolveImageDisplayUrl(firstUpstreamImage) : null;

  /** The setup form's choices become node data, then the shared generation service runs them in place. */
  const handleInlineSubmit = useCallback(async (prompt: string, config: PanoramaGenerateConfig) => {
    if (!prompt.trim() && config.sourceMode !== 'image') return;
    const sourceMode = config.sourceMode === 'image' ? 'image' : 'text';
    updateNodeData(id, {
      sourceMode,
      sourcePrompt: prompt,
      projection: config.projection,
      smartBase: config.smartBase,
      sourceImageUrl: config.directImageUrl ?? null,
    });
    const outcome = await submitNodeGeneration(id, {
      tool: {
        id: 'panorama',
        prompt,
        params: {
          sourceMode,
          projection: config.projection,
          smartBase: config.smartBase,
          directImageUrl: config.directImageUrl ?? undefined,
          referenceImages: config.referenceImages.map((image) => image.url).filter(Boolean),
        },
      },
    });
    // Upstream failures are reported by the service; input problems are explained here.
    if (!outcome.ok && outcome.reason !== 'failed') await showErrorDialog(outcome.message, t('common.error'));
  }, [id, t, updateNodeData]);

  const handleCopyPrompt = useCallback(async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!imageUrl || !displayImageUrl) {
      setNormalizedUrl(null);
      setViewerError(null);
      return;
    }
    let cancelled = false;
    setNormalizing(true);
    setViewerError(null);

    imageUrlToDataUrl(imageUrl)
      .catch(() => displayImageUrl)
      .then((loadableUrl) => normalizePanoramaToDataUrl(loadableUrl, { projection, featherPx: 48 })
        .catch(() => loadableUrl))
      .then((url) => {
        if (!cancelled) {
          setNormalizedUrl(url);
          setNormalizing(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNormalizedUrl(displayImageUrl);
          setViewerError(t('node.panoramaViewer.loadFailedDetail'));
          setNormalizing(false);
        }
      });
    return () => { cancelled = true; };
  }, [displayImageUrl, imageUrl, projection, t]);

  const handleClose = useCallback(() => {
    deleteNode(id);
  }, [deleteNode, id]);

  const handleAddCapturedViewToCanvas = useCallback(async (imageUrl: string, aspectRatio: string, displayName: string) => {
    const persistedImageUrl = imageUrl.startsWith('data:image/')
      ? await persistImageSource(imageUrl)
      : imageUrl;
    const createdNodeId = addDerivedExportNode(id, persistedImageUrl, aspectRatio, persistedImageUrl, {
      defaultTitle: displayName,
      resultKind: 'generic',
      aspectRatioStrategy: 'provided',
      sizeStrategy: 'autoMinEdge',
    });
    if (createdNodeId) {
      addEdge(id, createdNodeId, { provenance: 'generationResult' });
    }
  }, [addDerivedExportNode, addEdge, id]);

  const handleCaptureCurrent = useCallback(async (imageUrl: string, aspectRatio: string) => {
    await handleAddCapturedViewToCanvas(
      imageUrl,
      aspectRatio,
      t('node.panoramaViewer.currentViewNodeTitle')
    );
  }, [handleAddCapturedViewToCanvas, t]);

  const handleCaptureQuad = useCallback(async (imageUrl: string, aspectRatio: string) => {
    await handleAddCapturedViewToCanvas(
      imageUrl,
      aspectRatio,
      t('node.panoramaViewer.quadNodeTitle')
    );
  }, [handleAddCapturedViewToCanvas, t]);

  const title = resolveNodeDisplayName(CANVAS_NODE_TYPES.panorama, data);
  const generationError = typeof data.generationError === 'string' ? data.generationError : null;
  const status: NodeFrameStatus | null = data.isGenerating
    ? { kind: 'generating', startedAt: typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null }
    : generationError || viewerError ? { kind: 'error', label: generationError || viewerError || undefined } : null;

  if (!imageUrl) {
    // Empty-state: show the full setup form inline so the user can pick mode,
    // source, prompt, model config and hit 生成. Matches the "left-rail
    // panorama → panel-like setup" flow the user expects.
    return (
      <NodeFrame
        type={CANVAS_NODE_TYPES.panorama}
        selected={selected}
        icon={<Grid3x3 />}
        title={title}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={data.aspectRatio}
        status={status}
        width={width ?? 1080}
        height={height}
        resize={{ minWidth: 680, minHeight: 420, maxWidth: 1800, maxHeight: 1200 }}
        bodyStyle={{ padding: 0 }}
        actions={(
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); deleteNode(id); }}
            className="nodrag nopan nowheel"
            title="删除节点"
            aria-label="删除节点"
          >
            <X />
          </button>
        )}
      >
        <div className="flex min-h-0 flex-col overflow-auto" onDoubleClick={(e) => e.stopPropagation()}>
          <p className="px-4 py-2.5 text-[11px] text-text-muted">
            左侧管理素材 · 中间写提示词与参数 · 右侧选择生成方式和比例兜底
          </p>
        {data.isGenerating ? (
          <div className="flex h-[420px] items-center justify-center text-sm text-text-muted">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在生成全景图...
          </div>
        ) : (
          <div className="nodrag nopan nowheel">
            <PanoramaSetupForm
              onSubmit={handleInlineSubmit}
              onCopyPrompt={handleCopyPrompt}
              previewImageUrl={previewImageUrl}
              initialProjection={projection}
            />
          </div>
        )}
        {generationError && (
          <div className="mx-3 mb-3 flex flex-col items-start gap-1.5 text-xs text-danger">
            {data.generationReferenceFailure ? t('reference.needsPublicUrl', { slotKey: data.generationReferenceFailure.slotKey }) : generationError}
            {data.generationReferenceFailure ? <GenerationReferenceRetry nodeId={id} failure={data.generationReferenceFailure} /> : null}
          </div>
        )}
        </div>
      </NodeFrame>
    );
  }

  const viewerSurface = (
    <PanoramaViewerSurface
      normalizedUrl={normalizedUrl}
      normalizing={normalizing}
      viewerError={viewerError}
      projection={projection}
      initialYaw={data.initialYaw}
      initialPitch={data.initialPitch}
      initialFov={data.initialFov}
      useLegacyControlDirection={useLegacyControlDirection}
      controlSensitivity={panoramaControlSensitivity}
      className="w-full h-full"
      onExpand={() => setIsExpanded(true)}
      onCaptureCurrent={handleCaptureCurrent}
      onCaptureQuad={handleCaptureQuad}
      onClose={handleClose}
      closeLabel={t('node.panoramaViewer.deleteNode')}
    />
  );

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.panorama}
        selected={selected}
        icon={<Grid3x3 />}
        title={title}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={data.aspectRatio}
        status={status}
        variant="media"
        width={width ?? 560}
        height={height ?? 340}
        resize={{ minWidth: 320, minHeight: 220, maxWidth: 1800, maxHeight: 1200, keepAspectRatio: true }}
      >
        <div
          className="relative h-full w-full"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setIsExpanded(true);
          }}
        >
          {viewerSurface}
        </div>
      </NodeFrame>
      {isExpanded && createPortal(
        <div
          className="fixed inset-0 z-1400 flex items-center justify-center bg-(--scrim) p-5 backdrop-blur-xs"
          onClick={() => setIsExpanded(false)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div
            className="flex h-[min(88vh,920px)] w-[min(94vw,1440px)] flex-col overflow-hidden rounded-xl border border-(--line-strong) bg-elevated shadow-(--shadow-float)"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-(--line) px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-text-dark">{t('node.panoramaViewer.expandedTitle')}</div>
                <div className="mt-0.5 text-[11px] text-text-subtle">
                  {t('node.panoramaViewer.expandedHint')}
                </div>
              </div>
              <UiIconButton
                onClick={() => setIsExpanded(false)}
                aria-label={t('node.panoramaViewer.closeExpanded')}
                title={t('node.panoramaViewer.closeExpanded')}
              >
                <X className="h-4 w-4" />
              </UiIconButton>
            </div>
            <PanoramaViewerSurface
              normalizedUrl={normalizedUrl}
              normalizing={normalizing}
              viewerError={viewerError}
              projection={projection}
              initialYaw={data.initialYaw}
              initialPitch={data.initialPitch}
              initialFov={data.initialFov}
              useLegacyControlDirection={useLegacyControlDirection}
              controlSensitivity={panoramaControlSensitivity}
              className="min-h-0 flex-1"
              onCaptureCurrent={handleCaptureCurrent}
              onCaptureQuad={handleCaptureQuad}
              onClose={() => setIsExpanded(false)}
              closeLabel={t('node.panoramaViewer.closeExpanded')}
              expanded
            />
          </div>
        </div>,
        document.body
      )}
    </>
  );
});

PanoramaNode.displayName = 'PanoramaNode';
