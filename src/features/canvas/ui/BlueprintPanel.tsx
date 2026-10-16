import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Sparkles,
  MapPin,
  Globe,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Plus,
  ImageIcon,
  MousePointer2,
  UserRound,
  Box,
  Layers,
} from 'lucide-react';

import type { BlueprintActionPose, BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { BLUEPRINT_GENERIC_OBJECT_PRESET } from '@/features/canvas/domain/blueprintPresetCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { isExportImageNode, isImageEditNode, isUploadNode } from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
// Lazy-load the Three.js-heavy 3D editor; see BlueprintNode.tsx for
// the rationale (≈550 KB minified chunk, only worth fetching when a
// blueprint actually mounts).
const BlueprintScene = lazy(() =>
  import('./BlueprintScene').then((m) => ({ default: m.BlueprintScene })),
);
import { BlueprintObjectConsole } from './BlueprintObjectConsole';
import { BlueprintAssetPicker } from './BlueprintAssetPicker';
import { BlueprintCustomActionModal } from './BlueprintCustomActionModal';
import {
  buildBlueprintPrompt,
  type BlueprintConfig,
  type BlueprintReferenceImage,
} from '@/features/canvas/application/blueprintPrompt';
import { BLUEPRINT_SPRITE_PRESETS } from './blueprintPresets';
import {
  BLUEPRINT_DEFAULT_COLORS as BLUEPRINT_COLORS,
  BLUEPRINT_PERSON_ACTIONS as PERSON_ACTIONS,
  BLUEPRINT_SCENE_PRESETS as SCENE_PRESETS,
  genBlueprintItemId,
  itemPos,
  pos3dToLegacy as posToLegacy,
  writeUiAxis,
} from './blueprintCoordinates';

interface BlueprintPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (prompt: string, config: BlueprintConfig) => void;
  onCopyPrompt?: (prompt: string) => void;
  buttonRect: DOMRect;
  previewImageUrl?: string | null;
}

export const BlueprintPanel = memo(({ isOpen, onClose, onGenerate, onCopyPrompt, buttonRect, previewImageUrl }: BlueprintPanelProps) => {
  const { t } = useTranslation();
  const promptDefaultLanguage = useSettingsStore((state) => state.promptDefaultLanguage);
  const promptTemplateOverrides = useSettingsStore((state) => state.promptTemplateOverrides);
  const [mode, setMode] = useState<'flat' | 'panorama'>('flat');
  const [basePrompt, setBasePrompt] = useState('');
  const [items, setItems] = useState<BlueprintItem[]>([]);
  const [submitError, setSubmitError] = useState('');
  const [copyFlash, setCopyFlash] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [draftSelectedIds, setDraftSelectedIds] = useState<string[]>([]);
  const [importedReferenceIds, setImportedReferenceIds] = useState<string[]>([]);
  const [workflowMode, setWorkflowMode] = useState<'add' | 'select'>('add');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [draftSourceId, setDraftSourceId] = useState<'new' | string>('new');
  const [draftCategory, setDraftCategory] = useState<'person' | 'object' | 'scene'>('person');
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState(BLUEPRINT_COLORS[0]);
  const [draftPresetId, setDraftPresetId] = useState<string>('man');
  const [customActionDraft, setCustomActionDraft] = useState('');
  const [customActionModalOpen, setCustomActionModalOpen] = useState(false);
  const [customActionPose, setCustomActionPose] = useState<BlueprintActionPose>({});
  const [customActionPoses, setCustomActionPoses] = useState<Record<string, BlueprintActionPose>>({});
  const [customActions, setCustomActions] = useState<string[]>([]);
  const [followSelectedItem, setFollowSelectedItem] = useState(false);
  const wasOpenRef = useRef(false);

  const nodes = useCanvasStore((s) => s.nodes);

  const allReferenceImages = useMemo<BlueprintReferenceImage[]>(() => {
    // Palette rotated against the legend index — stays in sync with
    // DEFAULT_COLORS used by Blueprint3DEditor for visual continuity.
    const PALETTE = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#4ade80', '#38bdf8'];
    const list: BlueprintReferenceImage[] = [];
    nodes.forEach((n) => {
      if (isUploadNode(n) || isImageEditNode(n) || isExportImageNode(n)) {
        const raw = n.data.imageUrl || n.data.previewImageUrl;
        if (raw) {
          const label = (n.data.displayName as string | undefined)?.trim() || n.id.slice(0, 6);
          list.push({
            id: n.id,
            url: raw,
            label,
            color: PALETTE[list.length % PALETTE.length],
          });
        }
      }
    });
    return list;
  }, [nodes]);

  const referenceImages = useMemo<BlueprintReferenceImage[]>(() => {
    const byId = new Map(allReferenceImages.map((item) => [item.id, item]));
    const palette = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#4ade80', '#38bdf8'];
    return importedReferenceIds.reduce<BlueprintReferenceImage[]>((acc, id) => {
      const image = byId.get(id);
      if (!image) return acc;
      acc.push({ ...image, color: image.color ?? palette[acc.length % palette.length] });
      return acc;
    }, []);
  }, [allReferenceImages, importedReferenceIds]);

  const filteredAllReferences = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    if (!query) return allReferenceImages;
    return allReferenceImages.filter((image) => {
      return `${image.label} ${image.id}`.toLowerCase().includes(query);
    });
  }, [allReferenceImages, assetQuery]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen && !wasOpen) {
      setMode('flat');
      setBasePrompt('');
      setItems([]);
      setSubmitError('');
      setCopyFlash(false);
      setAssetQuery('');
      setIsAssetPickerOpen(false);
      const initialIds = allReferenceImages.slice(0, 8).map((image) => image.id);
      setImportedReferenceIds(initialIds);
      setDraftSelectedIds(initialIds);
      setWorkflowMode('add');
      setSelectedItemId(null);
      setDraftSourceId('new');
      setDraftCategory('person');
      setDraftName('');
      setDraftColor(BLUEPRINT_COLORS[0]);
      setDraftPresetId('man');
      setCustomActionDraft('');
      setCustomActionModalOpen(false);
      setFollowSelectedItem(false);
      setCustomActions([]);
    }
  }, [allReferenceImages, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const availableIds = new Set(allReferenceImages.map((image) => image.id));
    setImportedReferenceIds((current) => current.filter((id) => availableIds.has(id)));
    setDraftSelectedIds((current) => current.filter((id) => availableIds.has(id)));
  }, [allReferenceImages, isOpen]);

  const config: BlueprintConfig = {
    mode,
    backgroundImageUrl: mode === 'panorama' ? previewImageUrl ?? null : null,
    items,
    referenceImages,
    basePrompt,
    settings: {
      promptDefaultLanguage,
      promptTemplateOverrides,
    },
  };

  const composed = buildBlueprintPrompt(config);

  const handleSubmit = useCallback(() => {
    if (items.length === 0 && !basePrompt.trim()) {
      setSubmitError(t('directorStudio.legacyPanel.errors.emptyScene'));
      return;
    }
    if (mode === 'panorama' && !previewImageUrl) {
      setSubmitError(t('directorStudio.legacyPanel.errors.panoramaRequiresImage'));
      return;
    }
    setSubmitError('');
    onGenerate(composed, config);
  }, [basePrompt, composed, config, items.length, mode, onGenerate, previewImageUrl, t]);

  const handleCopyPrompt = useCallback(() => {
    onCopyPrompt?.(composed);
    setCopyFlash(true);
    setTimeout(() => setCopyFlash(false), 1400);
  }, [composed, onCopyPrompt]);

  const handleItemsChange = useCallback((nextItems: BlueprintItem[]) => {
    setItems(nextItems);
    if (selectedItemId && !nextItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
    }
    if (submitError) {
      setSubmitError('');
    }
  }, [selectedItemId, submitError]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const selectedRef = useMemo(
    () => referenceImages.find((image) => image.id === draftSourceId) ?? null,
    [draftSourceId, referenceImages]
  );
  const personPresets = useMemo(
    () => Object.values(BLUEPRINT_SPRITE_PRESETS).filter((preset) => preset.category === 'person'),
    []
  );
  const objectPresets = useMemo(
    () => [
      ...Object.values(BLUEPRINT_SPRITE_PRESETS).filter((preset) => preset.category === 'object'),
      BLUEPRINT_GENERIC_OBJECT_PRESET,
    ],
    []
  );
  const activeActionPresets = useMemo(
    () => [...PERSON_ACTIONS, ...customActions],
    [customActions]
  );
  const categoryOptions = useMemo(() => [
    { category: 'person' as const, label: t('directorStudio.legacyPanel.category.person'), Icon: UserRound },
    { category: 'object' as const, label: t('directorStudio.legacyPanel.category.object'), Icon: Box },
    { category: 'scene' as const, label: t('directorStudio.legacyPanel.category.scene'), Icon: Layers },
  ], [t]);

  const updateItem = useCallback((itemId: string, patch: Partial<BlueprintItem>) => {
    setItems((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      const next = { ...item, ...patch };
      return next;
    }));
  }, []);

  const updateItemCoordinate = useCallback((itemId: string, axis: 'x' | 'y' | 'z', value: number) => {
    setItems((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      const nextPos = writeUiAxis(itemPos(item), axis, value);
      const legacy = posToLegacy(nextPos);
      return { ...item, pos3d: nextPos, x: legacy.x, y: legacy.y };
    }));
  }, []);

  const deleteSelectedItem = useCallback(() => {
    if (!selectedItem) return;
    if (!window.confirm(t('directorStudio.legacyPanel.confirmDeleteItem', { name: selectedItem.label }))) return;
    setItems((current) => current.filter((item) => item.id !== selectedItem.id));
    setSelectedItemId(null);
  }, [selectedItem, t]);

  const openCustomActionModal = useCallback(() => {
    setCustomActionDraft('');
    setCustomActionPose({});
    setCustomActionModalOpen(true);
  }, []);

  const saveCustomAction = useCallback(() => {
    const name = customActionDraft.trim();
    const hasPose = Object.keys(customActionPose).length > 0;
    if (!name && !hasPose) return;
    const action = name || t('directorStudio.legacyPanel.customActionFallback');
    setCustomActions((current) => current.includes(action) ? current : [...current, action]);
    if (hasPose) {
      setCustomActionPoses((current) => ({ ...current, [action]: customActionPose }));
    }
    if (selectedItem && selectedItem.category === 'person') {
      updateItem(selectedItem.id, { action });
    }
    setCustomActionDraft('');
    setCustomActionPose({});
    setCustomActionModalOpen(false);
  }, [customActionDraft, customActionPose, selectedItem, t, updateItem]);

  /**
   * @-mention tokens drawn from imported reference images and current items.
   * Once an item claims an image (via refImageName / refImageUrl, or by
   * adopting the image's label), the image's default `@ImageN` / `@filename`
   * tokens are suppressed so the chosen item label is the only suggestion.
   */
  const mentionTokens = useMemo(() => {
    const tokens: string[] = [];
    const seen = new Set<string>();
    const push = (token: string) => {
      if (token.length > 1 && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    };
    referenceImages.forEach((image, index) => {
      const tokenName = t('directorStudio.legacyPanel.referenceTokenName', { index: index + 1 });
      const claimed = items.some((item) =>
        item.refImageUrl === image.url ||
        item.refImageName === image.label ||
        item.refImageName === tokenName ||
        item.label === tokenName ||
        item.label === image.label
      );
      if (claimed) return;
      // Default name only: filename variants stay suppressed so unclaimed
      // images surface one canonical reference token.
      push(`@${tokenName}`);
    });
    items.forEach((item) => {
      if (item.label) push(`@${item.label}`);
    });
    return tokens;
  }, [items, referenceImages, t]);

  const appendMentionToSelected = useCallback((token: string) => {
    if (!selectedItem) return;
    const current = selectedItem.relation ?? '';
    const glue = current.trim().length === 0 ? '' : ' ';
    updateItem(selectedItem.id, { relation: `${current}${glue}${token}` });
  }, [selectedItem, updateItem]);

  const removeCustomAction = useCallback((action: string) => {
    if (!window.confirm(t('directorStudio.legacyPanel.confirmDeleteAction', { name: action }))) return;
    setCustomActions((current) => current.filter((item) => item !== action));
  }, [t]);

  const handleDraftSource = useCallback((id: 'new' | string) => {
    setDraftSourceId(id);
    if (id === 'new') {
      setDraftName('');
      setDraftColor(BLUEPRINT_COLORS[items.length % BLUEPRINT_COLORS.length]);
      return;
    }
    const refIndex = referenceImages.findIndex((image) => image.id === id);
    const ref = referenceImages[refIndex];
    if (ref) {
      setDraftName(t('directorStudio.legacyPanel.referenceTokenName', { index: refIndex + 1 }));
      setDraftColor(ref.color ?? BLUEPRINT_COLORS[refIndex % BLUEPRINT_COLORS.length]);
    }
  }, [items.length, referenceImages, t]);

  const addDraftItem = useCallback(() => {
    const sourceIndex = selectedRef ? referenceImages.findIndex((image) => image.id === selectedRef.id) : -1;
    const label = draftName.trim() || (selectedRef
      ? t('directorStudio.legacyPanel.referenceTokenName', { index: sourceIndex + 1 })
      : draftCategory === 'scene'
        ? t('directorStudio.legacyPanel.sceneDefaultLabel')
        : t('directorStudio.legacyPanel.objectDefaultName', { count: items.length + 1 }));
    const color = draftColor || BLUEPRINT_COLORS[items.length % BLUEPRINT_COLORS.length];
    const basePos = {
      x: Math.max(-4, Math.min(4, (items.filter((item) => item.category !== 'scene').length % 5 - 2) * 1.4)),
      y: 0,
      z: Math.max(-3, Math.min(3, Math.floor(items.length / 5) * -1.2)),
    };
    const legacy = posToLegacy(basePos);
    const scenePreset = SCENE_PRESETS.find((preset) => preset.id === draftPresetId);
    const item: BlueprintItem = {
      id: genBlueprintItemId(),
      label,
      x: legacy.x,
      y: legacy.y,
      color,
      category: draftCategory,
      pos3d: draftCategory === 'scene' ? undefined : basePos,
      presetId: draftCategory === 'scene' ? undefined : draftPresetId,
      relation: draftCategory === 'scene' ? scenePreset?.description : undefined,
      refImageName: selectedRef?.label,
      refImageUrl: selectedRef?.url ?? null,
    };
    setItems((current) => [...current, item]);
    setSelectedItemId(item.id);
    setWorkflowMode('select');
    setDraftSourceId('new');
    setDraftName('');
    setDraftColor(BLUEPRINT_COLORS[(items.length + 1) % BLUEPRINT_COLORS.length]);
  }, [draftCategory, draftColor, draftName, draftPresetId, items, referenceImages, selectedRef, t]);

  const handleEditorSelectionChange = useCallback((id: string | null) => {
    setSelectedItemId(id);
    if (id) setWorkflowMode('select');
  }, []);

  if (!isOpen) return null;

  const panelWidth = Math.min(1280, Math.max(1080, window.innerWidth - 48));
  const panelLeft = Math.min(Math.max(8, buttonRect.left), window.innerWidth - panelWidth - 8);
  const panelTop = buttonRect.bottom + 6;

  const toggleDraftReference = (id: string) => {
    setDraftSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const confirmAssetImport = () => {
    setImportedReferenceIds(draftSelectedIds);
    setIsAssetPickerOpen(false);
  };

  return (
    <div
      className="fixed z-200 rounded-xl border border-white/12 bg-[#202020] shadow-2xl"
      style={{ left: panelLeft, top: panelTop, width: panelWidth }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/8">
        <div>
          <div className="text-sm font-semibold text-white">{t('directorStudio.legacyPanel.title')}</div>
          <div className="mt-0.5 text-[11px] text-white/42">
            {t('directorStudio.legacyPanel.subtitle')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={items.length === 0 && !basePrompt.trim()}
            className="flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs text-black hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Sparkles className="w-3 h-3" /> {t('directorStudio.legacyPanel.generate')}
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-md text-white/50 hover:text-white hover:bg-white/10"
          title={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-[206px_minmax(0,1fr)_280px] gap-3 p-4">
        <aside className="flex min-h-[560px] flex-col rounded-xl border border-white/10 bg-white/[0.035]">
          <div className="border-b border-white/8 px-3 py-2">
            <div className="text-xs font-semibold text-white/82">{t('directorStudio.legacyPanel.importImages')}</div>
            <div className="mt-0.5 text-[10px] text-white/38">
              {t('directorStudio.legacyPanel.importedCount', {
                imported: referenceImages.length,
                total: allReferenceImages.length,
              })}
            </div>
          </div>
          <div className="ui-scrollbar flex-1 overflow-y-auto p-2">
            {referenceImages.length === 0 ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-white/12 px-3 text-center">
                <ImageIcon className="mb-2 h-6 w-6 text-white/25" />
                <div className="text-[11px] text-white/55">{t('directorStudio.legacyPanel.emptyReferences')}</div>
              </div>
            ) : (
              <div className="space-y-2">
                {referenceImages.map((image, index) => {
                  const displayUrl = resolveImageDisplayUrl(image.url) ?? image.url;
                  return (
                    <button
                      key={image.id}
                      type="button"
                      onClick={() => {
                        handleDraftSource(image.id);
                        setWorkflowMode('add');
                      }}
                      className={`w-full rounded-lg border p-1.5 text-left transition-colors ${
                        draftSourceId === image.id ? 'border-accent/70 bg-accent/10' : 'border-white/10 bg-black/18 hover:border-white/25'
                      }`}
                    >
                      <div className="aspect-square overflow-hidden rounded-sm bg-black/30">
                        <img src={displayUrl} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: image.color }} />
                        <div className="min-w-0 flex-1 truncate text-[10px] text-white/78">
                          {t('directorStudio.legacyPanel.referenceListItem', { index: index + 1, label: image.label })}
                        </div>
                      </div>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setDraftSelectedIds(importedReferenceIds);
                    setIsAssetPickerOpen(true);
                  }}
                  className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-white/14 bg-black/12 text-white/42 hover:border-white/30 hover:text-white/70"
                  title={t('directorStudio.legacyPanel.addFromAssets')}
                >
                  <Plus className="h-6 w-6" />
                </button>
              </div>
            )}
          </div>
          <div className="border-t border-white/8 p-2">
            <button
              type="button"
              onClick={() => {
                setDraftSelectedIds(importedReferenceIds);
                setIsAssetPickerOpen(true);
              }}
              className="flex w-full items-center justify-center gap-1 rounded-md bg-white px-2 py-1.5 text-xs text-black hover:bg-gray-100"
            >
              <Plus className="h-3 w-3" /> {t('directorStudio.legacyPanel.manageImages')}
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-3">
          {/* Mode */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode('flat')}
              className={`flex items-center justify-center gap-1 rounded-lg py-2 text-xs ${mode === 'flat' ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
              title={t('directorStudio.legacyPanel.flatModeTitle')}
            >
              <MapPin className="w-3 h-3" /> {t('directorStudio.legacyPanel.flatMode')}
            </button>
            <button
              type="button"
              disabled={!previewImageUrl}
              onClick={() => setMode('panorama')}
              className={`flex items-center justify-center gap-1 rounded-lg py-2 text-xs ${mode === 'panorama' ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'} ${!previewImageUrl ? 'opacity-40 cursor-not-allowed' : ''}`}
              title={t('directorStudio.legacyPanel.panoramaModeTitle')}
            >
              <Globe className="w-3 h-3" /> {t('directorStudio.legacyPanel.panoramaMode')}
              {!previewImageUrl && t('directorStudio.legacyPanel.panoramaRequiresSelectionSuffix')}
            </button>
          </div>

          <Suspense
            fallback={
              <div
                className="flex items-center justify-center rounded-xl border border-white/10 bg-black/18 text-xs text-white/50"
                style={{ width: 760, height: 420 }}
              >
                {t('directorStudio.legacyPanel.loadingEditor')}
              </div>
            }
          >
            <BlueprintScene
              items={items}
              onItemsChange={handleItemsChange}
              referenceImages={referenceImages}
              mode={mode}
              panoramaUrl={mode === 'panorama' ? previewImageUrl ?? null : null}
              width={760}
              height={420}
              selectedItemId={selectedItemId}
              followSelectedItem={followSelectedItem}
              onSelectedItemChange={handleEditorSelectionChange}
              customActionPoses={customActionPoses}
            />
          </Suspense>

          <div className="rounded-xl border border-white/10 bg-black/18">
            <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
              <button
                type="button"
                onClick={() => setWorkflowMode('add')}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${workflowMode === 'add' ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
              >
                <Plus className="h-3 w-3" /> {t('directorStudio.legacyPanel.workflow.add')}
              </button>
              <button
                type="button"
                onClick={() => setWorkflowMode('select')}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${workflowMode === 'select' ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
              >
                <MousePointer2 className="h-3 w-3" /> {t('directorStudio.legacyPanel.workflow.select')}
              </button>
              <div className="ml-auto text-[10px] text-white/38">
                {t('directorStudio.legacyPanel.workflow.itemSummary', {
                  subjects: items.filter((item) => item.category !== 'scene').length,
                  scenes: items.filter((item) => item.category === 'scene').length,
                  refs: referenceImages.length,
                })}
              </div>
            </div>
            {workflowMode === 'add' ? (
              <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 p-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex items-center gap-1 overflow-x-auto pb-1">
                    <button
                      type="button"
                      onClick={() => handleDraftSource('new')}
                      className={`shrink-0 rounded-md px-2 py-1 text-xs ${draftSourceId === 'new' ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
                    >
                      <Plus className="mr-1 inline h-3 w-3" /> {t('directorStudio.legacyPanel.workflow.newObject')}
                    </button>
                    {referenceImages.map((image, index) => (
                      <button
                        key={image.id}
                        type="button"
                        onClick={() => handleDraftSource(image.id)}
                        className={`shrink-0 rounded-md px-2 py-1 text-xs ${draftSourceId === image.id ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
                      >
                        {t('directorStudio.legacyPanel.referenceTokenName', { index: index + 1 })}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={draftColor}
                      onChange={(event) => setDraftColor(event.target.value)}
                      className="h-8 w-8 rounded-sm border border-white/10 bg-transparent"
                      title={t('directorStudio.legacyPanel.workflow.objectColor')}
                    />
                    <input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      placeholder={selectedRef
                        ? t('directorStudio.legacyPanel.workflow.objectNameFromImagePlaceholder')
                        : t('directorStudio.legacyPanel.workflow.newObjectNamePlaceholder')}
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/85 outline-hidden placeholder:text-white/30 focus:border-white/25"
                    />
                  </div>
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="grid grid-cols-3 gap-1">
                    {categoryOptions.map(({ category: cat, label, Icon }) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => {
                          setDraftCategory(cat);
                          if (cat === 'person') setDraftPresetId(personPresets[0]?.id ?? 'man');
                          if (cat === 'object') setDraftPresetId(objectPresets[0]?.id ?? 'generic-object');
                          if (cat === 'scene') setDraftPresetId(SCENE_PRESETS[0].id);
                        }}
                        className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs ${draftCategory === cat ? 'bg-white text-black' : 'bg-white/8 text-white/70 hover:bg-white/14'}`}
                      >
                        <Icon className="h-3 w-3" /> {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex max-h-16 flex-wrap gap-1 overflow-y-auto pr-1">
                    {(draftCategory === 'person' ? personPresets : draftCategory === 'object' ? objectPresets : SCENE_PRESETS).map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setDraftPresetId(preset.id);
                          if (!draftName.trim()) setDraftName(preset.label);
                        }}
                        className={`rounded-sm px-2 py-0.5 text-[10px] ${draftPresetId === preset.id ? 'bg-accent text-white' : 'bg-white/8 text-white/65 hover:bg-white/14'}`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="col-span-2 flex justify-end gap-2">
                  <button type="button" onClick={() => { setDraftSourceId('new'); setDraftName(''); }} className="rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/70 hover:bg-white/14">
                    {t('common.cancel')}
                  </button>
                  <button type="button" onClick={addDraftItem} className="rounded-md bg-white px-3 py-1.5 text-xs text-black hover:bg-gray-100">
                    {t('directorStudio.legacyPanel.workflow.addToStudio')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-3 text-[11px] leading-5 text-white/50">
                {t('directorStudio.legacyPanel.workflow.selectHint')}
              </div>
            )}
          </div>

          {allReferenceImages.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/12 bg-white/3 px-3 py-2 text-[11px] leading-5 text-white/45">
              {t('directorStudio.legacyPanel.noAssetsHint')}
            </div>
          )}

          <textarea
            value={basePrompt}
            onChange={(e) => {
              setBasePrompt(e.target.value);
              if (submitError) setSubmitError('');
            }}
            placeholder={t('directorStudio.legacyPanel.basePromptPlaceholder')}
            className="h-16 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 outline-hidden placeholder:text-white/30 focus:border-white/25"
          />

          <details className="text-[11px] text-white/50">
            <summary className="cursor-pointer hover:text-white/80">{t('directorStudio.legacyPanel.showFinalPrompt')}</summary>
            <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/20 p-2 text-white/60 text-[11px]">{composed}</pre>
          </details>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11px] text-white/40">
              {submitError ? (
                <span className="inline-flex items-center gap-1 text-amber-300/90">
                  <AlertTriangle className="h-3 w-3" /> {submitError}
                </span>
              ) : referenceImages.length > 0 ? (
                t('directorStudio.legacyPanel.importedStatus', { count: referenceImages.length })
              ) : (
                t('directorStudio.legacyPanel.textOnlyHint')
              )}
            </div>
            <button
              type="button"
              onClick={handleCopyPrompt}
              className="rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/75 hover:bg-white/14"
            >
              {copyFlash ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : <Copy className="mr-1 inline h-3 w-3" />}
              {copyFlash ? t('directorStudio.legacyPanel.copied') : t('directorStudio.legacyPanel.copyPrompt')}
            </button>
          </div>
        </div>

        <BlueprintObjectConsole
          items={items}
          selectedItem={selectedItem}
          selectedItemId={selectedItemId}
          onSelect={(itemId) => {
            setSelectedItemId(itemId);
            if (itemId) setWorkflowMode('select');
          }}
          onUpdateItem={updateItem}
          onCoordinateChange={updateItemCoordinate}
          onDeleteItem={() => deleteSelectedItem()}
          onChangeCategory={(itemId, category) =>
            updateItem(itemId, {
              category,
              pos3d: category === 'scene' ? undefined : (selectedItem ? itemPos(selectedItem) : undefined),
            })
          }
          mentionTokens={mentionTokens}
          onAppendMention={appendMentionToSelected}
          actionPresets={activeActionPresets}
          customActions={customActions}
          onRemoveCustomAction={removeCustomAction}
          onOpenCustomActionModal={openCustomActionModal}
          followSelectedItem={followSelectedItem}
          onFollowChange={setFollowSelectedItem}
        />
      </div>

      <BlueprintAssetPicker
        isOpen={isAssetPickerOpen}
        onClose={() => setIsAssetPickerOpen(false)}
        images={filteredAllReferences}
        selectedIds={draftSelectedIds}
        onToggle={toggleDraftReference}
        onConfirm={confirmAssetImport}
        query={assetQuery}
        onQueryChange={setAssetQuery}
        title={t('directorStudio.legacyPanel.assetPickerTitle')}
        subtitle={t('directorStudio.legacyPanel.assetPickerSubtitle')}
      />

      <BlueprintCustomActionModal
        isOpen={customActionModalOpen}
        onClose={() => setCustomActionModalOpen(false)}
        nameValue={customActionDraft}
        poseValue={customActionPose}
        onNameChange={setCustomActionDraft}
        onPoseChange={setCustomActionPose}
        onSave={saveCustomAction}
      />
    </div>
  );
});

BlueprintPanel.displayName = 'BlueprintPanel';
