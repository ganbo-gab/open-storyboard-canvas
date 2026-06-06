import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { AlertCircle, Camera, Check, ChevronDown, Copy, Download, FolderOpen, Grid3x3, Maximize2, PenLine, RotateCcw, Scissors, Settings2, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import {
  isExportImageNode,
  isAiVideoNode,
  isImageEditNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { MULTI_FUNCTION_ITEMS } from '@/features/canvas/ui/MultiFunctionPanel';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  resolveGeneratedImageSaveFileName,
  resolveGeneratedVideoSaveFileName,
  resolveSuggestedImageStem,
  resolveSuggestedVideoStem,
} from '@/features/canvas/application/generatedMediaNaming';
import {
  copyImageSourceToClipboard,
  saveImageSourceToDownloads,
  saveImageSourceToDirectory,
  saveImageSourceToPath,
  saveVideoSourceToDirectory,
  saveVideoSourceToPath,
} from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  buildRetryGenerationFetchPatch,
  canRetryGenerationFetch,
} from '@/features/canvas/application/generationRetry';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { UiChipButton, UiPanel } from '@/components/ui';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
  node: CanvasNode;
  offset?: number;
}

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';
const PROMPT_PRESET_MENU_WIDTH = 260;
const PROMPT_PRESET_MENU_GAP = 8;

function normalizeDownloadPresetPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

function resolvePromptPresetMenuPosition(button: HTMLButtonElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  const centeredLeft = rect.left + rect.width / 2 - PROMPT_PRESET_MENU_WIDTH / 2;
  const maxLeft = Math.max(PROMPT_PRESET_MENU_GAP, window.innerWidth - PROMPT_PRESET_MENU_WIDTH - PROMPT_PRESET_MENU_GAP);

  return {
    x: Math.min(Math.max(PROMPT_PRESET_MENU_GAP, centeredLeft), maxLeft),
    y: rect.bottom + PROMPT_PRESET_MENU_GAP,
  };
}

export const NodeActionToolbar = memo(({ node, offset = NODE_TOOLBAR_OFFSET }: NodeActionToolbarProps) => {
  const { t } = useTranslation();
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const openPanel = usePanelStateStore((state) => state.openPanel);
  const closePanel = usePanelStateStore((state) => state.closePanel);

  /** Three UX variants:
   *  - A: upload node (user's raw image) — full tool set.
   *  - B: empty AI image node (no imageUrl yet) — toolbar is just the multi-function
   *       module chips + delete; click a chip to select/deselect it, and the chip's
   *       prompt template is composed at submit time.
   *  - C: image-bearing AI node (imageEdit with image OR exportImage) — same as A. */
  const caseKind: 'A' | 'B' | 'C' | 'V' | 'AI_VIDEO_INPUT' = useMemo(() => {
    if (isAiVideoNode(node)) return 'AI_VIDEO_INPUT';
    if (isVideoNode(node)) return 'V';
    if (isUploadNode(node)) return 'A';
    if (isImageEditNode(node)) {
      return node.data.imageUrl ? 'C' : 'B';
    }
    if (isExportImageNode(node)) return 'C';
    return 'A';
  }, [node]);

  const selectedChipId: string | null = useMemo(() => {
    if (caseKind !== 'B' || !isImageEditNode(node)) return null;
    return node.data.selectedFunctionChip ?? null;
  }, [caseKind, node]);

  const selectedPromptPresetId: string | null = useMemo(() => {
    if (!isImageEditNode(node)) return null;
    return node.data.selectedPromptPresetId ?? null;
  }, [node]);

  const handleToggleChip = useCallback((chipId: string) => {
    if (!isImageEditNode(node)) return;
    const next = selectedChipId === chipId ? null : chipId;
    updateNodeData(node.id, { selectedFunctionChip: next, selectedPromptPresetId: null });
  }, [node, selectedChipId, updateNodeData]);
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const normalizedDownloadPresetPaths = useMemo(
    () => normalizeDownloadPresetPaths(downloadPresetPaths),
    [downloadPresetPaths]
  );
  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [promptPresetMenu, setPromptPresetMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
  const [isCopySuccess, setIsCopySuccess] = useState(false);
  const [feedbackToast, setFeedbackToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);
  const [videoPreviewSource, setVideoPreviewSource] = useState<string | null>(null);
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const promptPresetMenuRef = useRef<HTMLDivElement | null>(null);
  const promptPresetAnchorRef = useRef<HTMLButtonElement | null>(null);
  const promptPresetPanelButtonRef = useRef<HTMLButtonElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const multiAngleButtonRef = useRef<HTMLButtonElement | null>(null);
  const lightingButtonRef = useRef<HTMLButtonElement | null>(null);
  const multiFunctionButtonRef = useRef<HTMLButtonElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const gridSplitButtonRef = useRef<HTMLButtonElement | null>(null);

  // Open panel on hover (for multiFunction, edit, gridSplit)
  const handleHoverOpen = useCallback((
    panelType: Parameters<typeof openPanel>[0],
    ref: RefObject<HTMLButtonElement | null>
  ) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (ref.current) {
      const el = ref.current;
      // Tag the button with a stable data-attribute so SelectedNodeOverlay can
      // re-locate it each animation frame (panel follows node as node drags).
      el.dataset.panelAnchor = `${node.id}:${panelType}`;
      openPanel(panelType, {
        nodeId: node.id,
        buttonKey: panelType,
        fallbackRect: el.getBoundingClientRect(),
      }, 'hover');
    }
  }, [openPanel, node.id]);

  const handleHoverLeave = useCallback(() => {
    hoverCloseTimerRef.current = setTimeout(() => {
      const currentPanelState = usePanelStateStore.getState();
      if (currentPanelState.openMode === 'click') {
        hoverCloseTimerRef.current = null;
        return;
      }
      // Don't close if pointer moved onto the panel itself
      if (currentPanelState.isPointerOverPanel) {
        hoverCloseTimerRef.current = null;
        return;
      }
      closePanel();
      hoverCloseTimerRef.current = null;
    }, 200);
  }, [closePanel]);
  const rawImageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const rawVideoSource = useMemo(() => {
    if (isVideoNode(node)) {
      return node.data.localVideoUrl || node.data.videoUrl || null;
    }
    return null;
  }, [node]);
  const imageSource = useMemo(
    () => (rawImageSource ? resolveImageDisplayUrl(rawImageSource) : null),
    [rawImageSource]
  );
  const videoSource = useMemo(
    () => (rawVideoSource ? resolveImageDisplayUrl(rawVideoSource) : null),
    [rawVideoSource]
  );
  const referenceImageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const canHandleImage = Boolean(imageSource);
  const canHandleVideo = Boolean(rawVideoSource && videoSource);
  const canRetryGeneration = canRetryGenerationFetch(node);
  const suggestedImageSavePath = useMemo(() => {
    if (isExportImageNode(node)) {
      return resolveGeneratedImageSaveFileName(node.data);
    }
    return `node-${node.id}.png`;
  }, [node]);
  const suggestedImageStem = useMemo(() => {
    if (isExportImageNode(node)) {
      return resolveSuggestedImageStem(node.data);
    }
    return `node-${node.id}`;
  }, [node]);
  const suggestedVideoSavePath = useMemo(() => {
    if (isVideoNode(node)) {
      return resolveGeneratedVideoSaveFileName(node.data);
    }
    return `node-${node.id}.mp4`;
  }, [node]);
  const suggestedVideoStem = useMemo(() => {
    if (isVideoNode(node)) {
      return resolveSuggestedVideoStem(node.data);
    }
    return `node-${node.id}`;
  }, [node]);

  const closePromptPresetMenu = useCallback(() => {
    setPromptPresetMenu(null);
  }, []);
  const isPromptPresetMenuOpen = promptPresetMenu !== null;

  const closeDownloadMenu = useCallback(() => {
    setIsDownloadMenuVisible(false);
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    downloadMenuCloseTimerRef.current = setTimeout(() => {
      setDownloadMenu(null);
      downloadMenuCloseTimerRef.current = null;
    }, UI_POPOVER_TRANSITION_MS);
  }, []);

  const showFeedbackToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setFeedbackToast({ message, tone });
    if (feedbackToastTimerRef.current) {
      clearTimeout(feedbackToastTimerRef.current);
    }
    feedbackToastTimerRef.current = setTimeout(() => {
      setFeedbackToast(null);
      feedbackToastTimerRef.current = null;
    }, 1800);
  }, []);

  const handleRetryGenerationFetch = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!canRetryGenerationFetch(node)) {
      return;
    }
    updateNodeData(node.id, buildRetryGenerationFetchPatch(node));
  }, [node, updateNodeData]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const menuElement = downloadMenuRef.current;
      if (!menuElement) {
        closeDownloadMenu();
        return;
      }
      if (menuElement.contains(event.target as Node)) {
        return;
      }
      closeDownloadMenu();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [closeDownloadMenu, downloadMenu]);

  useEffect(() => {
    if (!isPromptPresetMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const menuElement = promptPresetMenuRef.current;
      if (!menuElement) {
        closePromptPresetMenu();
        return;
      }
      if (menuElement.contains(event.target as Node)) {
        return;
      }
      const anchorElement = promptPresetAnchorRef.current;
      if (anchorElement?.contains(event.target as Node)) {
        return;
      }
      closePromptPresetMenu();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [closePromptPresetMenu, isPromptPresetMenuOpen]);

  useEffect(() => {
    if (!videoPreviewSource) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setVideoPreviewSource(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [videoPreviewSource]);

  useEffect(() => {
    if (!isPromptPresetMenuOpen) {
      return;
    }

    let frameId: number | null = null;
    const updatePosition = () => {
      const button = promptPresetAnchorRef.current;
      if (!button || !button.isConnected) {
        closePromptPresetMenu();
        return;
      }
      const nextPosition = resolvePromptPresetMenuPosition(button);
      setPromptPresetMenu((current) => {
        if (!current || (current.x === nextPosition.x && current.y === nextPosition.y)) {
          return current;
        }
        return nextPosition;
      });
      frameId = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [closePromptPresetMenu, isPromptPresetMenuOpen]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      setIsDownloadMenuVisible(true);
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [downloadMenu]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      if (feedbackToastTimerRef.current) {
        clearTimeout(feedbackToastTimerRef.current);
      }
      if (downloadMenuCloseTimerRef.current) {
        clearTimeout(downloadMenuCloseTimerRef.current);
      }
      if (hoverCloseTimerRef.current) {
        clearTimeout(hoverCloseTimerRef.current);
      }
    };
  }, []);

  const handleCopyImage = useCallback(async () => {
    if (!rawImageSource) return;
    try {
      await copyImageSourceToClipboard(rawImageSource);
      setIsCopySuccess(true);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopySuccess(false);
        copyFeedbackTimerRef.current = null;
      }, 1100);
      showFeedbackToast(t('nodeToolbar.copySuccess'));
    } catch (error) {
      console.error('Failed to copy image to clipboard', error);
      setIsCopySuccess(false);
      showFeedbackToast(t('nodeToolbar.copyFailed'), 'error');
    }
  }, [rawImageSource, showFeedbackToast, t]);

  const handleCopyVideoSource = useCallback(async () => {
    if (!rawVideoSource) return;
    try {
      await navigator.clipboard.writeText(rawVideoSource);
      setIsCopySuccess(true);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopySuccess(false);
        copyFeedbackTimerRef.current = null;
      }, 1100);
      showFeedbackToast(t('nodeToolbar.copySuccess'));
    } catch (error) {
      console.error('Failed to copy video source to clipboard', error);
      setIsCopySuccess(false);
      showFeedbackToast(t('nodeToolbar.copyFailed'), 'error');
    }
  }, [rawVideoSource, showFeedbackToast, t]);

  const handleDownloadSaveAs = useCallback(async () => {
    if (!rawImageSource) return;
    try {
      const selectedPath = await save({ defaultPath: suggestedImageSavePath });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      await saveImageSourceToPath(rawImageSource, selectedPath);
      closeDownloadMenu();
      showFeedbackToast(t('nodeToolbar.downloadSuccess'));
    } catch (error) {
      console.error('Failed to save image with save-as', error);
      showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
    }
  }, [closeDownloadMenu, rawImageSource, showFeedbackToast, suggestedImageSavePath, t]);

  const handleDownloadToDownloads = useCallback(async () => {
    if (!rawImageSource) return;
    try {
      await saveImageSourceToDownloads(rawImageSource, suggestedImageStem);
      closeDownloadMenu();
      showFeedbackToast(t('nodeToolbar.downloadSuccess'));
    } catch (error) {
      console.error('Failed to save image to downloads', error);
      showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
    }
  }, [closeDownloadMenu, rawImageSource, showFeedbackToast, suggestedImageStem, t]);

  const handleDownloadToPreset = useCallback(
    async (targetDir: string) => {
      if (!rawImageSource) return;
      try {
        await saveImageSourceToDirectory(rawImageSource, targetDir, suggestedImageStem);
        closeDownloadMenu();
        showFeedbackToast(t('nodeToolbar.downloadSuccess'));
      } catch (error) {
        console.error('Failed to save image to preset dir', error);
        showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
      }
    },
    [closeDownloadMenu, rawImageSource, showFeedbackToast, suggestedImageStem, t]
  );

  const handleDownloadVideoSaveAs = useCallback(async () => {
    if (!rawVideoSource) return;
    try {
      const selectedPath = await save({ defaultPath: suggestedVideoSavePath });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      await saveVideoSourceToPath(rawVideoSource, selectedPath);
      closeDownloadMenu();
      showFeedbackToast(t('nodeToolbar.downloadSuccess'));
    } catch (error) {
      console.error('Failed to save video with save-as', error);
      showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
    }
  }, [closeDownloadMenu, rawVideoSource, showFeedbackToast, suggestedVideoSavePath, t]);

  const handleDownloadVideoToPreset = useCallback(
    async (targetDir: string) => {
      if (!rawVideoSource) return;
      try {
        await saveVideoSourceToDirectory(rawVideoSource, targetDir, suggestedVideoStem);
        closeDownloadMenu();
        showFeedbackToast(t('nodeToolbar.downloadSuccess'));
      } catch (error) {
        console.error('Failed to save video to preset dir', error);
        showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
      }
    },
    [closeDownloadMenu, rawVideoSource, showFeedbackToast, suggestedVideoStem, t]
  );

  const handleOpenPromptPresetMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const button = event.currentTarget;
    if (caseKind !== 'B') {
      closePromptPresetMenu();
      button.dataset.panelAnchor = `${node.id}:promptPreset`;
      openPanel(
        'promptPreset',
        { nodeId: node.id, buttonKey: 'promptPreset', fallbackRect: button.getBoundingClientRect() },
        'click'
      );
      return;
    }
    if (isPromptPresetMenuOpen && promptPresetAnchorRef.current === button) {
      closePromptPresetMenu();
      return;
    }
    promptPresetAnchorRef.current = button;
    setPromptPresetMenu(resolvePromptPresetMenuPosition(button));
  }, [caseKind, closePromptPresetMenu, isPromptPresetMenuOpen, node.id, openPanel]);

  const handleManagePromptPresets = useCallback(() => {
    closePromptPresetMenu();
    openSettingsDialog({ category: 'promptPresets' });
  }, [closePromptPresetMenu]);

  const handleSelectPromptPreset = useCallback(async (presetId: string) => {
    const preset = promptPresets.find((item) => item.id === presetId);
    if (!preset) {
      await showErrorDialog(t('node.imageEdit.promptPresetMissing'), t('common.error'));
      return;
    }
    if (caseKind !== 'B' || !isImageEditNode(node)) {
      closePromptPresetMenu();
      return;
    }
    updateNodeData(node.id, {
      selectedPromptPresetId: preset.id,
      selectedFunctionChip: null,
    });
    closePromptPresetMenu();
  }, [
    caseKind,
    closePromptPresetMenu,
    node,
    promptPresets,
    t,
    updateNodeData,
  ]);

  const renderPromptPresetButton = (disabled = false) => (
    <UiChipButton
      ref={caseKind === 'B' ? promptPresetAnchorRef : promptPresetPanelButtonRef}
      type="button"
      className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${
        caseKind === 'B' && selectedPromptPresetId
          ? 'border-accent bg-accent/35 text-white ring-2 ring-accent/40'
          : TOOLBAR_NEUTRAL_BUTTON_CLASS
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      onClick={disabled ? undefined : handleOpenPromptPresetMenu}
      onMouseEnter={disabled || caseKind !== 'B'
        ? undefined
        : (event) => {
          promptPresetAnchorRef.current = event.currentTarget;
          setPromptPresetMenu(resolvePromptPresetMenuPosition(event.currentTarget));
        }}
      title={t('nodeToolbar.promptPreset') as string}
    >
      {caseKind === 'B' && selectedPromptPresetId && <Check className="h-3.5 w-3.5 text-white" />}
      <Sparkles className="h-3.5 w-3.5" />
      {t('nodeToolbar.promptPreset')}
      <ChevronDown className="h-3 w-3 opacity-70" />
    </UiChipButton>
  );

  const promptPresetMenuElement = promptPresetMenu && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={promptPresetMenuRef}
          className="fixed z-[1000] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl backdrop-blur-sm"
          style={{ left: `${promptPresetMenu.x}px`, top: `${promptPresetMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="px-2.5 pb-2 text-xs font-medium text-text-muted">
            {t('nodeToolbar.promptPresetMenuTitle')}
          </div>
          {promptPresets.length > 0 ? (
            <div className="max-h-[240px] space-y-1 overflow-y-auto pr-1">
              {promptPresets.map((preset) => {
                const active = selectedPromptPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      active
                        ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                        : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                    }`}
                    title={preset.prompt}
                    onClick={() => { void handleSelectPromptPreset(preset.id); }}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--canvas-node-border)] bg-[var(--canvas-node-field-bg)] px-3 py-4 text-center text-xs text-text-muted">
              {t('nodeToolbar.promptPresetEmpty')}
            </div>
          )}
          <button
            type="button"
            className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--canvas-node-field-border)] px-2.5 text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={handleManagePromptPresets}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('nodeToolbar.managePromptPresets')}
          </button>
        </div>,
        document.body
      )
    : null;

  const feedbackToastElement = feedbackToast && typeof document !== 'undefined'
    ? createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[1300] -translate-x-1/2">
          <div
            className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-2xl backdrop-blur ${
              feedbackToast.tone === 'success'
                ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-50'
                : 'border-red-400/45 bg-red-500/20 text-red-50'
            }`}
          >
            {feedbackToast.tone === 'success'
              ? <Check className="h-4 w-4" />
              : <AlertCircle className="h-4 w-4" />}
            <span>{feedbackToast.message}</span>
          </div>
        </div>,
        document.body
      )
    : null;

  const videoPreviewElement = videoPreviewSource && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/82 p-6 backdrop-blur-sm"
          onClick={() => setVideoPreviewSource(null)}
        >
          <div
            className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white shadow-lg transition-colors hover:bg-white/15"
              aria-label={t('common.close')}
              onClick={() => setVideoPreviewSource(null)}
            >
              <X className="h-4 w-4" />
            </button>
            <video
              src={videoPreviewSource}
              className="max-h-[88vh] w-full bg-black object-contain"
              controls
              autoPlay
              playsInline
            />
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <>
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={offset}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        {/* Case B: empty AI node — render multi-function chips only. Clicking
            a chip selects the module (blue highlight); clicking again
            clears. One at a time. The chip's prompt template is composed in
            ImageEditNode.handleGenerate at submit time. */}
        {caseKind === 'B' && MULTI_FUNCTION_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = selectedChipId === item.id;
          return (
            <UiChipButton
              key={item.id}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${
                active
                  ? 'border-accent bg-accent/45 text-white ring-2 ring-accent/60 shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
                  : TOOLBAR_NEUTRAL_BUTTON_CLASS
              }`}
              onClick={(e) => { e.stopPropagation(); handleToggleChip(item.id); }}
              title={t(item.descKey) as string}
            >
              {active && <Check className="h-3.5 w-3.5 text-white" />}
              <Icon className="h-3.5 w-3.5" />
              {t(item.titleKey) as string}
            </UiChipButton>
          );
        })}

        {caseKind === 'B' && renderPromptPresetButton()}

        {/* Case A / C: full tool chips. */}
        {caseKind !== 'B' && caseKind !== 'V' && caseKind !== 'AI_VIDEO_INPUT' && (<>
        {/* 多角度 - Multi-angle */}
        <UiChipButton
          ref={multiAngleButtonRef}
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(e) => {
            e.stopPropagation();
            if (multiAngleButtonRef.current) {
              {
                const el = multiAngleButtonRef.current;
                el.dataset.panelAnchor = `${node.id}:multiAngle`;
                openPanel('multiAngle', { nodeId: node.id, buttonKey: 'multiAngle', fallbackRect: el.getBoundingClientRect() }, 'click');
              }
            }
          }}
        >
          <Camera className="h-3.5 w-3.5" />
          {t('nodeToolbar.multiAngle')}
        </UiChipButton>

        {/* 打光 - Lighting */}
        <UiChipButton
          ref={lightingButtonRef}
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(e) => {
            e.stopPropagation();
            if (lightingButtonRef.current) {
              {
                const el = lightingButtonRef.current;
                el.dataset.panelAnchor = `${node.id}:lighting`;
                openPanel('lighting', { nodeId: node.id, buttonKey: 'lighting', fallbackRect: el.getBoundingClientRect() }, 'click');
              }
            }
          }}
        >
          <Sun className="h-3.5 w-3.5" />
          {t('nodeToolbar.lighting')}
        </UiChipButton>

        {/* 多功能 - Multi-function */}
        <UiChipButton
          ref={multiFunctionButtonRef}
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(e) => {
            e.stopPropagation();
            if (multiFunctionButtonRef.current) {
              {
                const el = multiFunctionButtonRef.current;
                el.dataset.panelAnchor = `${node.id}:multiFunction`;
                openPanel('multiFunction', { nodeId: node.id, buttonKey: 'multiFunction', fallbackRect: el.getBoundingClientRect() }, 'click');
              }
            }
          }}
          onMouseEnter={() => handleHoverOpen('multiFunction', multiFunctionButtonRef)}
          onMouseLeave={handleHoverLeave}
        >
          <Grid3x3 className="h-3.5 w-3.5" />
          {t('nodeToolbar.multiFunction')}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </UiChipButton>

        {/* 编辑 - Edit */}
        <UiChipButton
          ref={editButtonRef}
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(e) => {
            e.stopPropagation();
            if (editButtonRef.current) {
              {
                const el = editButtonRef.current;
                el.dataset.panelAnchor = `${node.id}:edit`;
                openPanel('edit', { nodeId: node.id, buttonKey: 'edit', fallbackRect: el.getBoundingClientRect() }, 'click');
              }
            }
          }}
          onMouseEnter={() => handleHoverOpen('edit', editButtonRef)}
          onMouseLeave={handleHoverLeave}
        >
          <PenLine className="h-3.5 w-3.5" />
          {t('nodeToolbar.edit')}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </UiChipButton>

        {/* 宫格切分 - Grid Split */}
        <UiChipButton
          ref={gridSplitButtonRef}
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(e) => {
            e.stopPropagation();
            if (gridSplitButtonRef.current) {
              {
                const el = gridSplitButtonRef.current;
                el.dataset.panelAnchor = `${node.id}:gridSplit`;
                openPanel('gridSplit', { nodeId: node.id, buttonKey: 'gridSplit', fallbackRect: el.getBoundingClientRect() }, 'click');
              }
            }
          }}
          onMouseEnter={() => handleHoverOpen('gridSplit', gridSplitButtonRef)}
          onMouseLeave={handleHoverLeave}
        >
          <Scissors className="h-3.5 w-3.5" />
          {t('nodeToolbar.gridSplit')}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </UiChipButton>

        {referenceImageSource && renderPromptPresetButton()}

        {/* 复制 - Copy */}
        {canHandleImage && (
          <UiChipButton
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopySuccess ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200' : ''
            }`}
            onClick={() => { void handleCopyImage(); }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copy')}
          </UiChipButton>
        )}

        {/* 下载 - Download */}
        {canHandleImage && (
          <UiChipButton
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              if (normalizedDownloadPresetPaths.length === 0) {
                void handleDownloadToDownloads();
                return;
              }
              if (normalizedDownloadPresetPaths.length === 1) {
                void handleDownloadToPreset(normalizedDownloadPresetPaths[0]);
                return;
              }
              setDownloadMenu({ x: event.clientX, y: event.clientY });
              setIsDownloadMenuVisible(false);
            }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('nodeToolbar.download')}
          </UiChipButton>
        )}

        {/* 放大预览 - Zoom Preview */}
        {canHandleImage && imageSource && (
          <UiChipButton
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              useCanvasStore.getState().openImageViewer(imageSource);
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t('nodeToolbar.zoomPreview')}
          </UiChipButton>
        )}
        </>)}{/* end case A/C */}

        {caseKind === 'V' && canHandleVideo && videoSource && (<>
        <UiChipButton
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(event) => {
            event.stopPropagation();
            setVideoPreviewSource(videoSource);
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {t('nodeToolbar.zoomPreview')}
        </UiChipButton>

        <UiChipButton
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
            isCopySuccess ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200' : ''
          }`}
          onClick={(event) => {
            event.stopPropagation();
            void handleCopyVideoSource();
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          {t('nodeToolbar.copy')}
        </UiChipButton>

        <UiChipButton
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
          onClick={(event) => {
            event.stopPropagation();
            if (normalizedDownloadPresetPaths.length === 0) {
              void handleDownloadVideoSaveAs();
              return;
            }
            if (normalizedDownloadPresetPaths.length === 1) {
              void handleDownloadVideoToPreset(normalizedDownloadPresetPaths[0]);
              return;
            }
            setDownloadMenu({ x: event.clientX, y: event.clientY });
            setIsDownloadMenuVisible(false);
          }}
        >
          <Download className="h-3.5 w-3.5" />
          {t('nodeToolbar.download')}
        </UiChipButton>
        </>)}

        {canRetryGeneration && (
          <UiChipButton
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={handleRetryGenerationFetch}
            title={t('nodeToolbar.retryFetch') as string}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('nodeToolbar.retryFetch')}
          </UiChipButton>
        )}

        {/* 删除 - Delete (shared by A / B / C / V) */}
        <UiChipButton
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25`}
          onClick={(event) => {
            event.stopPropagation();
            deleteNode(node.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>

      {downloadMenu && (
        <div
          ref={downloadMenuRef}
          className={`fixed z-[120] min-w-[280px] rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
        >
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={() => {
              void (caseKind === 'V'
                ? handleDownloadVideoSaveAs()
                : handleDownloadSaveAs());
            }}
          >
            <Download className="h-4 w-4" />
            {t('nodeToolbar.saveAs')}
          </button>

          {normalizedDownloadPresetPaths.length > 0 ? (
            <div className="mt-1 space-y-1 border-t border-[var(--canvas-node-divider)] pt-2">
              {normalizedDownloadPresetPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
                  onClick={() => {
                    void (caseKind === 'V'
                      ? handleDownloadVideoToPreset(path)
                      : handleDownloadToPreset(path));
                  }}
                  title={path}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1 border-t border-[var(--canvas-node-divider)] px-2.5 pt-2 text-xs text-text-muted">
              {t('nodeToolbar.noDownloadPresetPathsHint')}
            </div>
          )}
        </div>
      )}

    </ReactFlowNodeToolbar>
    {promptPresetMenuElement}
    {feedbackToastElement}
    {videoPreviewElement}
    </>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
