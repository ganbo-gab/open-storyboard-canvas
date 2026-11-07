import { useMemo, type ReactNode } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import {
  AudioLines,
  BookmarkPlus,
  Camera,
  Clapperboard,
  Copy,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Globe2,
  Grid3x3,
  Info,
  LayoutGrid,
  Maximize2,
  NotebookPen,
  PenLine,
  Power,
  PowerOff,
  RotateCcw,
  RotateCw,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Ungroup,
  Upload,
  UserRoundPlus,
} from 'lucide-react';
import { downloadAsset } from '@/features/assets/application/assetDownloads';
import { useTranslation } from 'react-i18next';

import {
  copyImageSourceToClipboard,
  saveAudioSourceToPath,
  saveImageSourceToDirectory,
  saveImageSourceToDownloads,
  saveImageSourceToPath,
  saveVideoSourceToDirectory,
  saveVideoSourceToPath,
} from '@/commands/image';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { runNodeMediaEdit, type MediaEditOperation } from '@/features/canvas/application/media';
import { saveNodesToAssets } from '@/features/canvas/application/selectionAssets';
import { CANVAS_GENERATION_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import { openMediaEditor, mediaEditErrorText } from '@/features/canvas/ui/MediaEditDialog';
import { openCanvasAssetEditor } from '@/features/assets/ui/CanvasAssetEditHost';
import { useCharacterLibraryStore } from '@/features/characters/store/characterLibraryStore';
import { openGenerationDraftOptionsEditor } from '@/features/canvas/ui/GenerationDraftOptionsDialog';
import { getCanvasHistoryReuseOptions } from '@/features/library/application/projectLibraryActions';
import { openKnowledgeCapture } from '@/features/knowledge/ui/KnowledgeCaptureDialog';
import {
  resolveGeneratedImageSaveFileName,
  resolveGeneratedVideoSaveFileName,
  resolveSuggestedImageStem,
  resolveSuggestedVideoStem,
} from '@/features/canvas/application/generatedMediaNaming';
import { buildRetryGenerationFetchPatch, canRetryGenerationFetch } from '@/features/canvas/application/generationRetry';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeSelectionToolbarMode } from '@/features/canvas/domain/nodeRegistry';
import { useCanvasStore } from '@/stores/canvasStore';
import type { PanelType } from '@/stores/panelStateStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { openGenerationDetails } from '@/features/library/ui/GenerationDetailsDialog';

/** What a toolbar action does when picked; the toolbar owns anchoring, menus and feedback. */
export type NodeActionEffect =
  | { kind: 'panel'; panel: PanelType }
  | { kind: 'run'; run: () => void | Promise<string | void> }
  /** Save media: one click when at most one download folder is configured, else a folder menu. */
  | { kind: 'download'; targets: DownloadTarget[] }
  /** Durable node source (asset-media/path/URL); the toolbar resolves it to a display URL on open. */
  | { kind: 'preview'; media: 'image' | 'video'; source: string };

export interface DownloadTarget {
  label: string;
  save: () => Promise<boolean>;
}

export interface NodeAction {
  id: string;
  label: string;
  icon: ReactNode;
  tone?: 'danger';
  /** Opens a panel or menu (renders a disclosure chevron). */
  disclosure?: boolean;
  effect: NodeActionEffect;
}

function sanitizeFileStem(raw: string): string {
  const compact = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').replace(/\s+/g, '-');
  return compact.replace(/^\.+|\.+$/g, '') || 'audio';
}

export function inferAudioExtension(source: string, fallback = 'wav'): string {
  const mime = /^data:audio\/([^;,]+)/i.exec(source.trim());
  if (mime) {
    const subtype = mime[1].toLowerCase();
    if (subtype.includes('mpeg')) return 'mp3';
    if (subtype.includes('x-wav') || subtype.includes('wave')) return 'wav';
    return subtype.replace(/[^a-z0-9]+/g, '') || fallback;
  }
  let path = source;
  try { path = new URL(source).pathname; } catch { /* plain path */ }
  return /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(path)?.[1]?.toLowerCase() ?? fallback;
}

/**
 * How many leading actions fit in `available` pixels, given each action's measured width.
 * When not all fit, room is reserved for the "More" button. Returns 0 until measured.
 */
export function fitActionCount(widths: readonly number[], available: number, moreWidth: number, gap: number): number {
  if (widths.length === 0) return 0;
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= available) return widths.length;
  let used = moreWidth;
  let count = 0;
  for (const width of widths) {
    if (used + gap + width > available) break;
    used += gap + width;
    count += 1;
  }
  return count;
}

const unique = (paths: readonly string[]) => Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));

/**
 * Selection toolbar actions for one node, most frequent first. One list per node kind; the
 * toolbar decides how many fit. Generation inputs (functions, presets) live in the composer's
 * `/` menu, so generator nodes only get node-level actions here.
 */
export function useNodeActions(node: CanvasNode): NodeAction[] {
  const { t } = useTranslation();
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);

  return useMemo(() => {
    const actions: NodeAction[] = [];
    const folders = unique(downloadPresetPaths);
    const panel = (id: PanelType, label: string, icon: ReactNode): NodeAction =>
      ({ id, label, icon, disclosure: true, effect: { kind: 'panel', panel: id } });
    const downloads = (
      saveAs: () => Promise<boolean>,
      toFolder: ((dir: string) => Promise<boolean>) | null,
      quick?: () => Promise<boolean>,
    ): DownloadTarget[] => {
      if (!toFolder || folders.length === 0) return [{ label: t('nodeToolbar.saveAs'), save: quick ?? saveAs }];
      if (folders.length === 1) return [{ label: folders[0], save: () => toFolder(folders[0]) }];
      return [{ label: t('nodeToolbar.saveAs'), save: saveAs }, ...folders.map((dir) => ({ label: dir, save: () => toFolder(dir) }))];
    };
    /** One undoable media-edit transaction; the toolbar shows the returned message or the thrown error. */
    const transform = async (operation: MediaEditOperation) => {
      try {
        await runNodeMediaEdit(node.id, operation);
        return t('mediaEdit.done', { count: 1 });
      } catch (error) {
        throw new Error(mediaEditErrorText(t, error));
      }
    };
    const saveToAssets = async () => {
      const result = await saveNodesToAssets([node.id]);
      if (!result.assetIds.length) throw new Error(t('rework.canvas.saveToAssetsNothing'));
      return t('rework.canvas.savedToAssets', { count: result.assetIds.length });
    };

    const imageSource = isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)
      ? node.data.imageUrl || node.data.previewImageUrl || null
      : null;
    const mode = getNodeSelectionToolbarMode(node.type);

    if (mode === 'full' && imageSource) {
      const stem = isExportImageNode(node) ? resolveSuggestedImageStem(node.data) : `node-${node.id}`;
      const fileName = isExportImageNode(node) ? resolveGeneratedImageSaveFileName(node.data) : `node-${node.id}.png`;
      actions.push(
        panel('edit', t('nodeToolbar.edit'), <PenLine />),
        panel('multiAngle', t('nodeToolbar.multiAngle'), <Camera />),
        panel('lighting', t('nodeToolbar.lighting'), <Sun />),
        panel('panorama', t('nodeToolbar.panorama'), <Globe2 />),
        panel('gridSplit', t('nodeToolbar.gridSplit'), <LayoutGrid />),
        panel('multiFunction', t('nodeToolbar.multiFunction'), <Grid3x3 />),
        panel('promptPreset', t('nodeToolbar.promptPreset'), <Sparkles />),
        { id: 'preview', label: t('nodeToolbar.zoomPreview'), icon: <Maximize2 />, effect: { kind: 'preview', media: 'image', source: imageSource } },
        {
          id: 'download', label: t('nodeToolbar.download'), icon: <Download />,
          effect: { kind: 'download', targets: downloads(
            async () => {
              const path = await save({ defaultPath: fileName });
              if (!path || Array.isArray(path)) return false;
              await saveImageSourceToPath(imageSource, path);
              return true;
            },
            async (dir) => { await saveImageSourceToDirectory(imageSource, dir, stem); return true; },
            async () => { await saveImageSourceToDownloads(imageSource, stem); return true; },
          ) },
        },
        { id: 'copy', label: t('nodeToolbar.copy'), icon: <Copy />, effect: { kind: 'run', run: async () => {
          await copyImageSourceToClipboard(imageSource);
          return t('nodeToolbar.copySuccess');
        } } },
        { id: 'editContent', label: '编辑图片', icon: <SlidersHorizontal />, disclosure: true, effect: { kind: 'run', run: () => openCanvasAssetEditor(node.id) } },
        { id: 'rotate', label: t('mediaEdit.rotate'), icon: <RotateCw />, effect: { kind: 'run', run: () => transform({ kind: 'image.transform', rotate: 90 }) } },
        { id: 'flipX', label: t('mediaEdit.flipX'), icon: <FlipHorizontal2 />, effect: { kind: 'run', run: () => transform({ kind: 'image.transform', rotate: 0, flipX: true }) } },
        { id: 'flipY', label: t('mediaEdit.flipY'), icon: <FlipVertical2 />, effect: { kind: 'run', run: () => transform({ kind: 'image.transform', rotate: 0, flipY: true }) } },
        { id: 'saveAsset', label: t('rework.canvas.saveToAssets'), icon: <BookmarkPlus />, effect: { kind: 'run', run: saveToAssets } },
        { id: 'createCharacter', label: t('rework.canvas.createCharacter'), icon: <UserRoundPlus />, effect: { kind: 'run', run: async () => {
          const store = useCharacterLibraryStore.getState();
          await store.initialize();
          const character = await store.createFromCanvasImageNode({ id: node.id, imageUrl: imageSource });
          if (!character) throw new Error(useCharacterLibraryStore.getState().error?.message ?? t('rework.canvas.createCharacterFailed'));
          return t('rework.canvas.characterCreated', { name: character.name });
        } } },
      );
      if (isUploadNode(node)) {
        actions.push({ id: 'reupload', label: t('rework.canvas.reupload'), icon: <Upload />, effect: { kind: 'run', run: () => {
          canvasEventBus.publish('upload-node/reupload', { nodeId: node.id });
        } } });
      }
    }

    if (mode === 'full' && isVideoNode(node)) {
      const source = node.data.localVideoUrl || node.data.videoUrl || null;
      if (source) {
        const stem = resolveSuggestedVideoStem(node.data);
        actions.push(
          { id: 'preview', label: t('nodeToolbar.zoomPreview'), icon: <Maximize2 />, effect: { kind: 'preview', media: 'video', source } },
          {
            id: 'download', label: t('nodeToolbar.download'), icon: <Download />,
            effect: { kind: 'download', targets: downloads(
              async () => {
                const path = await save({ defaultPath: resolveGeneratedVideoSaveFileName(node.data) });
                if (!path || Array.isArray(path)) return false;
                await saveVideoSourceToPath(source, path);
                return true;
              },
              async (dir) => { await saveVideoSourceToDirectory(source, dir, stem); return true; },
            ) },
          },
          { id: 'copy', label: t('nodeToolbar.copy'), icon: <Copy />, effect: { kind: 'run', run: async () => {
            await navigator.clipboard.writeText(source);
            return t('nodeToolbar.copySuccess');
          } } },
          { id: 'videoEdit', label: t('mediaEdit.videoTitle'), icon: <Clapperboard />, disclosure: true, effect: { kind: 'run', run: () => openMediaEditor(node.id, 'video') } },
          { id: 'saveAsset', label: t('rework.canvas.saveToAssets'), icon: <BookmarkPlus />, effect: { kind: 'run', run: saveToAssets } },
        );
      }
    }

    if (mode === 'full' && isAudioNode(node)) {
      const source = node.data.localAudioUrl || node.data.audioUrl || null;
      if (source) {
        const stem = sanitizeFileStem(node.data.generatedFileName || node.data.sourceFileName || node.data.displayName || `audio-${node.id}`);
        actions.push(
          {
            id: 'download', label: t('nodeToolbar.download'), icon: <Download />,
            effect: { kind: 'download', targets: downloads(async () => {
              const path = await save({ defaultPath: `${stem}.${inferAudioExtension(source)}` });
              if (!path || Array.isArray(path)) return false;
              await saveAudioSourceToPath(source, path);
              return true;
            }, null) },
          },
          { id: 'audioTrim', label: t('nodeToolbar.audioTrim'), icon: <Scissors />, effect: { kind: 'run', run: () => {
            const duration = typeof node.data.durationSeconds === 'number' && node.data.durationSeconds > 0 ? node.data.durationSeconds : 1;
            useCanvasStore.getState().updateNodeData(node.id, {
              isAudioTrimMode: true,
              audioTrimStartSeconds: 0,
              audioTrimEndSeconds: Math.min(duration, Math.max(0.1, duration * 0.5)),
            });
          } } },
          { id: 'audioEdit', label: t('mediaEdit.audioTitle'), icon: <AudioLines />, disclosure: true, effect: { kind: 'run', run: () => openMediaEditor(node.id, 'audio') } },
          { id: 'saveAsset', label: t('rework.canvas.saveToAssets'), icon: <BookmarkPlus />, effect: { kind: 'run', run: saveToAssets } },
        );
      }
    }

    if (canRetryGenerationFetch(node)) {
      const state = String((node.data as Record<string, unknown>).generationJobState ?? '');
      actions.push({
        id: 'retry',
        label: t(state === 'recoverable_wait' || state === 'unknown' ? 'nodeToolbar.safeRecover' : 'nodeToolbar.retryFetch'),
        icon: <RotateCcw />,
        effect: { kind: 'run', run: () => useCanvasStore.getState().updateNodeData(node.id, buildRetryGenerationFetchPatch(node)) },
      });
    }
    if (node.type === CANVAS_NODE_TYPES.textAnnotation) {
      const content = typeof node.data.content === 'string' ? node.data.content : '';
      actions.push({ id: 'downloadText', label: t('rework.download'), icon: <Download />, effect: { kind: 'run', run: () => downloadAsset({ id: node.id, kind: 'text', source: content, name: String(node.data.displayName ?? 'text') }) } });
    }
    if (node.type === CANVAS_NODE_TYPES.group) {
      actions.push({ id: 'ungroup', label: t('nodeToolbar.ungroup'), icon: <Ungroup />, effect: { kind: 'run', run: () => { useCanvasStore.getState().ungroupNode(node.id); } } });
    }
    if (CANVAS_GENERATION_NODE_TYPES.some((type) => type === node.type)) {
      const enabled = !('enabled' in node.data && node.data.enabled === false);
      actions.push({
        id: 'toggleEnabled',
        label: t(enabled ? 'rework.canvas.disableNode' : 'rework.canvas.enableNode'),
        icon: enabled ? <PowerOff /> : <Power />,
        effect: { kind: 'run', run: async () => {
          const result = await canvasCommandRegistry.execute({ type: 'node.setEnabled', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [node.id], enabled: !enabled } }, 'ui');
          if (!result.ok) throw new Error(result.error.message);
        } },
      });
    }
    if (getCanvasHistoryReuseOptions(node.data)) {
      actions.push({ id: 'restoredOptions', label: t('rework.generationHistory.restoredOptions'), icon: <SlidersHorizontal />, disclosure: true,
        effect: { kind: 'run', run: () => openGenerationDraftOptionsEditor(node.id) } });
    }
    actions.push({ id: 'generationDetails', label: t('ui.details.title'), icon: <Info />, disclosure: true,
      effect: { kind: 'run', run: () => openGenerationDetails({ nodeId: node.id }) } });
    actions.push({ id: 'saveKnowledge', label: t('rework.knowledge.captureTitle'), icon: <NotebookPen />,
      effect: { kind: 'run', run: () => openKnowledgeCapture([node.id]) } });
    actions.push({
      id: 'delete',
      label: t('common.delete'),
      icon: <Trash2 />,
      tone: 'danger',
      effect: { kind: 'run', run: () => {
        void canvasCommandRegistry.execute({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [node.id] } }, 'ui');
      } },
    });
    return actions;
  }, [downloadPresetPaths, node, t]);
}
