import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

import { useCanvasStore } from '@/stores/canvasStore';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  isExportImageNode,
  isImageEditNode,
  isTagGroupNode,
  isUploadNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeSelectionToolbarMode } from '@/features/canvas/domain/nodeRegistry';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { submitNodeGeneration } from '@/features/canvas/application/generation';
import { getCanvasHistoryReuseOptions } from '@/features/library/application/projectLibraryActions';
import type { BlueprintConfig } from '@/features/canvas/application/blueprintPrompt';
import { MultiAnglePanel } from './MultiAnglePanel';
import { LightingControlPanel } from './LightingControlPanel';
import { MultiFunctionPanel } from './MultiFunctionPanel';
import { PromptPresetPanel } from './PromptPresetPanel';
import type { ModelConfigValue } from './ModelConfigPicker';
import { EditPanel } from './EditPanel';
import { GridSplitPanel } from './GridSplitPanel';
import type { PanoramaGenerateConfig } from './PanoramaPanel';

// Lazy-load the heavy generation panels. PanoramaPanel pulls in
// @photo-sphere-viewer (~106 KB), and BlueprintPanel transitively
// pulls in three.js (~550 KB). Since both panels are conditionally
// rendered (the user has to click an action toolbar button to open
// them), there's no value in loading their chunks on cold start.
const PanoramaPanel = lazy(() =>
  import('./PanoramaPanel').then((m) => ({ default: m.PanoramaPanel })),
);
const BlueprintPanel = lazy(() =>
  import('./BlueprintPanel').then((m) => ({ default: m.BlueprintPanel })),
);
import { TagGroupToolbar } from './TagGroupToolbar';
import { NodeToolbar } from '@/features/canvas/overlays/NodeToolbar';
import { placePanelAnchor } from './overlayPlacement';

export const SelectedNodeOverlay = memo(() => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const panelState = usePanelStateStore();
  const setPointerOverPanel = usePanelStateStore((state) => state.setPointerOverPanel);
  const closePanel = usePanelStateStore((state) => state.closePanel);
  const activeToolDialog = useCanvasStore((state) => state.activeToolDialog);
  const collapseNodeActionToolbarByDefault = useSettingsStore(
    (state) => state.collapseNodeActionToolbarByDefault
  );

  // Measure on mount/content resize, before paint. Editors stay put; transient menus dismiss on outside gestures.
  const [liveButtonRect, setLiveButtonRect] = useState<DOMRect | null>(null);
  const panelHostRef = useRef<HTMLDivElement | null>(null);
  const resizePanels = useSettingsStore((state) => state.workspacePreferences.resizePanels);
  useEffect(() => {
    if (!panelState.isOpen || !panelState.type) return;
    const host = panelHostRef.current;
    if (!host) return;
    const key = `node-tool:${panelState.type}`;
    let installed: HTMLElement | null = null;
    const install = () => {
      const panel = host.firstElementChild;
      if (!(panel instanceof HTMLElement) || panel === installed) return;
      installed = panel;
      panel.dataset.resizableTool = resizePanels ? 'true' : 'false';
      const saved = useSettingsStore.getState().workspacePreferences.panelSizes[key];
      if (saved) { panel.style.width = `${Math.min(saved.width, innerWidth - 32)}px`; panel.style.height = `${Math.min(saved.height, innerHeight - 64)}px`; }
    };
    install();
    const observer = new MutationObserver(install);
    observer.observe(host, { childList: true });
    const persist = () => {
      if (!resizePanels || !installed) return;
      const { width, height } = installed.getBoundingClientRect();
      const settings = useSettingsStore.getState();
      const saved = settings.workspacePreferences.panelSizes[key];
      if (width >= 240 && height >= 160 && (saved?.width !== width || saved?.height !== height)) settings.setWorkspacePreferences({ panelSizes: { ...settings.workspacePreferences.panelSizes, [key]: { width, height } } });
    };
    window.addEventListener('pointerup', persist);
    return () => { observer.disconnect(); window.removeEventListener('pointerup', persist); };
  }, [panelState.isOpen, panelState.type, resizePanels, liveButtonRect !== null]);
  useEffect(() => {
    if (!panelState.isOpen) return;
    const dismiss = (event: PointerEvent) => {
      // Working editors keep their draft until an explicit close; option menus dismiss outside.
      if (panelState.type && ['multiAngle', 'lighting', 'panorama', 'blueprint'].includes(panelState.type)) return;
      const target = event.target;
      if (!(target instanceof Element) || panelHostRef.current?.contains(target)
        || target.closest('.ui-menu, [data-ui-modal], [data-panel-anchor]')) return;
      if (target.closest('.react-flow__node')?.getAttribute('data-id') === panelState.anchor?.nodeId) return;
      closePanel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.ui-menu, [data-ui-modal]')) return;
      event.preventDefault(); event.stopPropagation(); closePanel();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape); };
  }, [panelState.isOpen, panelState.type, panelState.anchor?.nodeId, closePanel]);
  useEffect(() => { if (activeToolDialog) closePanel(); }, [activeToolDialog, closePanel]);
  useLayoutEffect(() => {
    if (!panelState.isOpen || !panelState.anchor) { setLiveButtonRect(null); return; }
    const { fallbackRect, nodeId, buttonKey } = panelState.anchor;
    if (!liveButtonRect) { setLiveButtonRect(fallbackRect); return; }
    const host = panelHostRef.current;
    if (!host) return;
    let observed: Element | null = null;
    const owner = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    const initialOwnerRect = owner?.getBoundingClientRect();
    const place = () => {
      const panel = host.firstElementChild;
      if (!(panel instanceof HTMLElement)) return;
      const bounds = { width: panel.offsetWidth, height: panel.offsetHeight };
      const button = document.querySelector<HTMLElement>(`[data-panel-anchor="${CSS.escape(`${nodeId}:${buttonKey}`)}"]`);
      const ownerRect = owner?.getBoundingClientRect();
      const rect = button?.getBoundingClientRect() ?? new DOMRect(
        fallbackRect.left + (ownerRect && initialOwnerRect ? ownerRect.left - initialOwnerRect.left : 0),
        fallbackRect.top + (ownerRect && initialOwnerRect ? ownerRect.top - initialOwnerRect.top : 0), fallbackRect.width, fallbackRect.height,
      );
      const placed = placePanelAnchor(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        bounds, { width: innerWidth, height: innerHeight },
      );
      setLiveButtonRect((previous) => previous?.x === placed.x && previous.y === placed.y && previous.width === placed.width && previous.height === placed.height
        ? previous : new DOMRect(placed.x, placed.y, placed.width, placed.height));
      if (observed !== panel) { if (observed) resize.unobserve(observed); resize.observe(panel); observed = panel; }
    };
    const resize = new ResizeObserver(place);
    const mutation = new MutationObserver(place);
    mutation.observe(host, { childList: true });
    place(); window.addEventListener('resize', place);
    let frame = 0;
    const follow = () => { place(); frame = requestAnimationFrame(follow); };
    frame = requestAnimationFrame(follow);
    return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', place); cancelAnimationFrame(frame); };
  }, [panelState.isOpen, panelState.anchor, liveButtonRect !== null]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  const selectedNodeToolbarMode = selectedNode
    ? getNodeSelectionToolbarMode(selectedNode.type)
    : 'none';
  // The setting only folds image toolbars; other kinds have few enough actions to show.
  const collapsibleToolbar = Boolean(
    collapseNodeActionToolbarByDefault
    && selectedNode
    && (isUploadNode(selectedNode) || isImageEditNode(selectedNode) || isExportImageNode(selectedNode))
  );

  // A panel belongs to its node: close it when that node is gone or loses its toolbar.
  useEffect(() => {
    if (!panelState.isOpen || !panelState.anchor) {
      return;
    }
    const anchorNode = nodes.find((node) => node.id === panelState.anchor?.nodeId);
    if (!anchorNode || selectedNodeId !== anchorNode.id || getNodeSelectionToolbarMode(anchorNode.type) === 'none') {
      closePanel();
    }
  }, [closePanel, nodes, selectedNodeId, panelState.anchor, panelState.isOpen]);

  const selectedNodeImageData = useMemo(() => {
    const data = selectedNode?.data as { imageUrl?: string | null; previewImageUrl?: string | null; aspectRatio?: string } | undefined;
    return {
      rawReferenceImage: data?.imageUrl || data?.previewImageUrl || undefined,
      previewImageUrl: data?.imageUrl || data?.previewImageUrl
        ? resolveImageDisplayUrl(data.imageUrl || data.previewImageUrl || '')
        : undefined,
      aspectRatio: data?.aspectRatio || '1:1',
    };
  }, [selectedNode]);

  const handleCopyPrompt = useCallback(async (prompt: string) => {
    if (!prompt.trim()) {
      await showErrorDialog('当前未生成可复制的提示词', '错误');
      return;
    }
    await navigator.clipboard.writeText(prompt);
  }, []);

  /**
   * Every panel submits through the shared generation service (same request assembly, lock and
   * result nodes as the composer and Agents). Input problems are explained here; upstream
   * failures are reported by the service on the result node.
   */
  const submitTool = useCallback(async (
    tool: { id: string; prompt?: string; params?: Record<string, unknown> },
    options: { selectResult?: boolean } = {},
  ) => {
    if (!selectedNode) {
      await showErrorDialog(t('directorStudio.overlay.noSelectedNode'), t('common.error'));
      return;
    }
    const restored = getCanvasHistoryReuseOptions(selectedNode.data);
    const outcome = await submitNodeGeneration(selectedNode.id, { ...(restored ?? {}), tool });
    if (!outcome.ok) {
      if (outcome.reason !== 'failed' && outcome.reason !== 'busy') await showErrorDialog(outcome.message, t('common.error'));
      return;
    }
    closePanel();
    if (options.selectResult && outcome.resultNodeIds[0]) setSelectedNode(outcome.resultNodeIds[0]);
  }, [closePanel, selectedNode, setSelectedNode, t]);

  const handleSubmitPrompt = useCallback((prompt: string) => submitTool({
    id: panelState.type ?? 'edit',
    prompt,
  }), [panelState.type, submitTool]);

  const handleSubmitPromptPreset = useCallback((presetId: string, modelConfig: ModelConfigValue) => submitTool(
    { id: 'promptPreset', params: { presetId, modelConfig } },
    { selectResult: true },
  ), [submitTool]);

  const handleSubmitPanorama = useCallback((prompt: string, config: PanoramaGenerateConfig) => submitTool({
    id: 'panorama',
    prompt,
    params: {
      sourceMode: config.sourceMode === 'image' ? 'image' : 'text',
      projection: config.projection,
      smartBase: config.smartBase,
      directImageUrl: config.directImageUrl ?? undefined,
      referenceImages: config.referenceImages.map((image) => image.url).filter(Boolean),
    },
  }), [submitTool]);

  const handleSubmitBlueprint = useCallback((prompt: string, config: BlueprintConfig) => submitTool({
    id: 'blueprint',
    prompt,
    params: {
      mode: config.mode,
      referenceImages: config.referenceImages.map((image) => image.url).filter(Boolean),
    },
  }), [submitTool]);

  if (!selectedNode) {
    return null;
  }

  return (
    <>
      {isTagGroupNode(selectedNode) ? (
        <TagGroupToolbar nodeId={selectedNode.id} data={selectedNode.data} />
      ) : selectedNodeToolbarMode !== 'none' && !panelState.isOpen && !activeToolDialog ? (
        // Keyed by node so expanded/collapsed state and measurements never leak between nodes.
        <NodeToolbar key={selectedNode.id} node={selectedNode} collapsible={collapsibleToolbar} />
      ) : null}

      {/* Global panel rendering — works for all node types */}
      {panelState.isOpen && panelState.anchor && liveButtonRect && (
        createPortal(<div
          ref={panelHostRef}
          className="canvas-tool-panel-host"
          data-canvas-overlay=""
          data-modal={panelState.type && ['multiAngle', 'lighting', 'panorama', 'blueprint'].includes(panelState.type) || undefined}
          onMouseEnter={() => setPointerOverPanel(true)}
          onMouseLeave={() => setPointerOverPanel(false)}
        >
          {panelState.type === 'multiAngle' && (
            <MultiAnglePanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(_options, prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              onCopyPrompt={(prompt) => {
                void handleCopyPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'lighting' && (
            <LightingControlPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(_options, prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              onCopyPrompt={(prompt) => {
                void handleCopyPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'multiFunction' && (
            <MultiFunctionPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'promptPreset' && (
            <PromptPresetPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onGenerate={(presetId, modelConfig) => handleSubmitPromptPreset(presetId, modelConfig)}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'edit' && (
            <EditPanel
              node={{ id: panelState.anchor.nodeId } as CanvasNode}
              isOpen={true}
              onClose={() => panelState.closePanel()}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'gridSplit' && (
            <GridSplitPanel
              node={{ id: panelState.anchor.nodeId } as CanvasNode}
              isOpen={true}
              onClose={() => panelState.closePanel()}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'panorama' && (
            <Suspense fallback={null}>
              <PanoramaPanel
                isOpen={true}
                onClose={() => panelState.closePanel()}
                onGenerate={(prompt, config) => {
                  void handleSubmitPanorama(prompt, config);
                }}
                onCopyPrompt={(prompt) => {
                  void handleCopyPrompt(prompt);
                }}
                buttonRect={liveButtonRect}
                previewImageUrl={selectedNodeImageData.previewImageUrl}
              />
            </Suspense>
          )}
          {panelState.type === 'blueprint' && (
            <Suspense fallback={null}>
              <BlueprintPanel
                isOpen={true}
                onClose={() => panelState.closePanel()}
                onGenerate={(prompt, config) => {
                  void handleSubmitBlueprint(prompt, config);
                }}
                onCopyPrompt={(prompt) => {
                  void handleCopyPrompt(prompt);
                }}
                buttonRect={liveButtonRect}
                previewImageUrl={selectedNodeImageData.previewImageUrl}
              />
            </Suspense>
          )}
        </div>, document.body)
      )}
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';
