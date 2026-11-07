import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CheckCircle2,
  Compass,
  Copy,
  Globe,
  HelpCircle,
  ImageIcon,
  Info,
  Plus,
  Search,
  Sparkles,
  Type,
  X,
} from 'lucide-react';

import { UiBadge, UiButton, UiChipButton, UiIconButton, UiInput, UiSegmented, UiTextArea } from '@/components/ui';
import { ModelConfigPicker } from './ModelConfigPicker';
import {
  type PanoramaGenerateConfig,
  type PanoramaProjection,
  type PanoramaReferenceImage,
  type PanoramaSourceMode,
} from './PanoramaPanel';
import { buildPanoramaPrompt } from '@/features/canvas/application/panoramaPrompt';
import { isExportImageNode, isImageEditNode, isUploadNode } from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import {
  insertReferenceToken,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

interface PanoramaSetupFormProps {
  onSubmit: (composedPrompt: string, config: PanoramaGenerateConfig) => void;
  onCopyPrompt?: (prompt: string) => void;
  previewImageUrl?: string | null;
  compact?: boolean;
  initialProjection?: PanoramaProjection;
  initialSourceMode?: PanoramaSourceMode;
  initialSmartBase?: boolean;
}

const PANORAMA_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb7185', '#38bdf8', '#4ade80'];

function normalizeInitialSourceMode(mode: PanoramaSourceMode | undefined, hasPreview: boolean): PanoramaSourceMode {
  if (mode === 'image') return 'image';
  if (mode === 'text' || mode === 'ai') return 'ai';
  return hasPreview ? 'image' : 'ai';
}

export const PanoramaSetupForm = memo(({
  onSubmit,
  onCopyPrompt,
  previewImageUrl,
  compact = false,
  initialProjection = 'spherical',
  initialSourceMode,
  initialSmartBase = true,
}: PanoramaSetupFormProps) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const promptDefaultLanguage = useSettingsStore((state) => state.promptDefaultLanguage);
  const promptTemplateOverrides = useSettingsStore((state) => state.promptTemplateOverrides);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [projection, setProjection] = useState<PanoramaProjection>(initialProjection);
  const [sourceMode, setSourceMode] = useState<PanoramaSourceMode>(
    normalizeInitialSourceMode(initialSourceMode, Boolean(previewImageUrl))
  );
  const [smartBase, setSmartBase] = useState(initialSmartBase);
  const [prompt, setPrompt] = useState('');
  const [showSmartHelp, setShowSmartHelp] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draftSelectedIds, setDraftSelectedIds] = useState<string[]>([]);
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [referencePickerIndex, setReferencePickerIndex] = useState(0);
  const [referencePickerCursor, setReferencePickerCursor] = useState<number | null>(null);

  const canvasReferences = useMemo<PanoramaReferenceImage[]>(() => {
    const list: PanoramaReferenceImage[] = [];
    nodes.forEach((node) => {
      if (!isUploadNode(node) && !isImageEditNode(node) && !isExportImageNode(node)) return;
      const raw = node.data.imageUrl || node.data.previewImageUrl;
      if (!raw) return;
      const label = (node.data.displayName as string | undefined)?.trim() || `图${list.length + 1}`;
      list.push({
        id: node.id,
        url: resolveImageDisplayUrl(raw) ?? raw,
        label,
        color: PANORAMA_COLORS[list.length % PANORAMA_COLORS.length],
      });
    });
    return list;
  }, [nodes]);

  const allReferences = useMemo<PanoramaReferenceImage[]>(() => {
    if (!previewImageUrl) return canvasReferences;
    const exists = canvasReferences.some((item) => item.url === previewImageUrl);
    if (exists) return canvasReferences;
    return [{
      id: 'selected-preview',
      url: previewImageUrl,
      label: '当前图片',
      color: PANORAMA_COLORS[0],
    }, ...canvasReferences];
  }, [canvasReferences, previewImageUrl]);

  useEffect(() => {
    if (selectedIds.length > 0) {
      const available = new Set(allReferences.map((item) => item.id));
      setSelectedIds((current) => current.filter((id) => available.has(id)));
      return;
    }
    if (previewImageUrl) {
      const first = allReferences.find((item) => item.url === previewImageUrl) ?? allReferences[0];
      if (first) setSelectedIds([first.id]);
    }
  }, [allReferences, previewImageUrl, selectedIds.length]);

  // Image-to-panorama is a direct conversion of ONE image into a panorama —
  // multiple references make no sense semantically. When the user toggles
  // into image mode, drop everything except the first selection so the rail
  // and asset picker reflect the single-image-only flow.
  useEffect(() => {
    if (sourceMode !== 'image') return;
    setSelectedIds((current) => (current.length > 1 ? current.slice(0, 1) : current));
    setDraftSelectedIds((current) => (current.length > 1 ? current.slice(0, 1) : current));
  }, [sourceMode]);

  const selectedReferences = useMemo(() => {
    const byId = new Map(allReferences.map((item) => [item.id, item]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((item): item is PanoramaReferenceImage => Boolean(item));
  }, [allReferences, selectedIds]);

  const filteredReferences = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    if (!query) return allReferences;
    return allReferences.filter((item) => `${item.label} ${item.id}`.toLowerCase().includes(query));
  }, [allReferences, assetQuery]);

  const defaultAiPrompt = '生成一张可用于全景查看器的完整沉浸式全景图，画面必须是比例2比1的等距柱状投影结构，宽度是高度的2倍，结合导入图片的主体、材质、色彩和风格，并根据文字描述补全四周环境、天空或天花板、地面或地板，让左右边缘自然衔接';
  const effectivePrompt = sourceMode === 'image'
    ? prompt.trim()
    : (prompt.trim() || defaultAiPrompt);
  const composed = sourceMode === 'image'
    ? effectivePrompt
    : buildPanoramaPrompt(sourceMode, projection, effectivePrompt, {
        promptDefaultLanguage,
        promptTemplateOverrides,
      });
  const directReference = selectedReferences[0] ?? null;

  const insertPanoramaReference = useCallback((imageIndex: number) => {
    const marker = `@图${imageIndex + 1}`;
    const cursor = referencePickerCursor ?? prompt.length;
    const { nextText, nextCursor } = insertReferenceToken(prompt, cursor, marker);
    setPrompt(nextText);
    setShowReferencePicker(false);
    setReferencePickerCursor(null);
    setReferencePickerIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [prompt, referencePickerCursor]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selectionStart = event.currentTarget.selectionStart ?? prompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deleteRange = resolveReferenceAwareDeleteRange(
        prompt,
        selectionStart,
        selectionEnd,
        event.key === 'Backspace' ? 'backward' : 'forward',
        selectedReferences.length
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(prompt, deleteRange);
        setPrompt(nextText);
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
        });
        return;
      }
    }

    if (showReferencePicker && selectedReferences.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setReferencePickerIndex((current) => (current + 1) % selectedReferences.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setReferencePickerIndex((current) => current === 0 ? selectedReferences.length - 1 : current - 1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertPanoramaReference(referencePickerIndex);
        return;
      }
    }

    if (event.key === '@' && selectedReferences.length > 0) {
      event.preventDefault();
      setReferencePickerCursor(event.currentTarget.selectionStart ?? prompt.length);
      setReferencePickerIndex(0);
      setShowReferencePicker(true);
      return;
    }

    if (event.key === 'Escape' && showReferencePicker) {
      event.preventDefault();
      setShowReferencePicker(false);
      setReferencePickerCursor(null);
      setReferencePickerIndex(0);
    }
  }, [insertPanoramaReference, prompt, referencePickerIndex, selectedReferences.length, showReferencePicker]);

  const handleSubmit = useCallback(() => {
    if (sourceMode === 'image' && !directReference) return;
    onSubmit(composed, {
      projection,
      sourceMode,
      smartBase,
      referenceImages: selectedReferences,
      directImageUrl: sourceMode === 'image' ? directReference?.url ?? null : null,
    });
  }, [composed, directReference, onSubmit, projection, selectedReferences, smartBase, sourceMode]);

  const toggleDraftReference = (id: string) => {
    setDraftSelectedIds((current) => {
      if (sourceMode === 'image') {
        return current.includes(id) ? [] : [id];
      }
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  };

  const openAssetPicker = () => {
    setDraftSelectedIds(selectedIds);
    setIsAssetPickerOpen(true);
  };

  const confirmAssetPicker = () => {
    setSelectedIds(draftSelectedIds);
    setIsAssetPickerOpen(false);
  };

  const projectionButtons = (
    <UiSegmented
      value={projection}
      onChange={setProjection}
      options={[
        { value: 'spherical', label: '720°球体', icon: <Globe className="h-3.5 w-3.5" /> },
        { value: 'cylindrical', label: '360°环绕', icon: <Compass className="h-3.5 w-3.5" /> },
      ]}
      size="sm"
      className="w-full"
      aria-label="投影方式"
    />
  );

  const modeButtons = (
    <UiSegmented
      value={sourceMode === 'image' ? 'image' : 'ai'}
      onChange={setSourceMode}
      options={[
        { value: 'ai', label: 'AI生成全景图', icon: <Type className="h-3.5 w-3.5" /> },
        { value: 'image', label: '图生全景图', icon: <ImageIcon className="h-3.5 w-3.5" /> },
      ]}
      size="sm"
      className="w-full"
      aria-label="生成方式"
    />
  );

  const smartControl = (
    <div className="relative flex items-center gap-1.5">
      <UiChipButton
        active={smartBase}
        aria-pressed={smartBase}
        onClick={() => setSmartBase((current) => !current)}
        className="h-8 gap-1 whitespace-nowrap rounded-md text-xs"
      >
        {smartBase && <CheckCircle2 className="h-3 w-3" />}
        智能比例合成
      </UiChipButton>
      <UiIconButton
        onClick={() => setShowSmartHelp((current) => !current)}
        variant="secondary"
        aria-label="智能比例合成说明"
        aria-expanded={showSmartHelp}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </UiIconButton>
      {showSmartHelp && (
        <div className="absolute bottom-full right-0 z-30 mb-2 w-[340px] rounded-lg border border-[var(--line)] bg-elevated p-3 text-[11px] leading-5 text-text-muted shadow-[var(--shadow-pop)]">
          AI生成全景图会优先提交目标比例；如果供应商没有 2:1 / 4:1，会选择最接近的宽比例生成，再裁切、羽化并归一化。
        </div>
      )}
    </div>
  );

  const body = (
    <div className="grid min-h-[560px] grid-cols-[270px_minmax(0,1fr)_330px]">
      <aside className="flex flex-col border-r border-(--canvas-node-divider) bg-(--canvas-node-subtle-bg)">
        <div className="border-b border-(--canvas-node-divider) px-3 py-2">
          <div className="text-xs font-semibold text-text-dark">{sourceMode === 'image' ? '全景源图（单张）' : '全景素材'}</div>
          <div className="mt-0.5 text-[10px] text-text-muted">
            {sourceMode === 'image'
              ? (selectedReferences.length > 0 ? '已选 1 张源图' : '请选择 1 张源图')
              : `${selectedReferences.length} / ${allReferences.length} 张已加入`}
          </div>
        </div>
        <div className="ui-scrollbar nowheel flex-1 overflow-y-auto p-2">
          <div className="space-y-2">
            {selectedReferences.map((image, index) => (
              <div key={image.id} className="rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-bg-strong) p-1.5">
                <div className="aspect-video overflow-hidden rounded-sm bg-(--canvas-node-media-bg)">
                  <AssetMedia kind="image" source={image.url} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: image.color }} />
                  <div className="min-w-0 flex-1 truncate text-[10px] text-text-dark">{sourceMode === 'image' ? '源图' : `图${index + 1}`} · {image.label}</div>
                  <UiIconButton
                    size="sm"
                    onClick={() => setSelectedIds((current) => current.filter((id) => id !== image.id))}
                    className="h-5 w-5"
                    aria-label={`移除${image.label}`}
                  >
                    <X className="h-3 w-3" />
                  </UiIconButton>
                </div>
              </div>
            ))}
            {(sourceMode !== 'image' || selectedReferences.length === 0) && (
              <UiButton
                variant="secondary"
                onClick={openAssetPicker}
                className="aspect-video h-auto w-full rounded-lg border border-dashed border-[var(--line-strong)]"
                title={sourceMode === 'image' ? '选择全景源图' : '从资产加入图片'}
                aria-label={sourceMode === 'image' ? '选择全景源图' : '从资产加入图片'}
              >
                <Plus className="h-6 w-6" />
              </UiButton>
            )}
            {sourceMode === 'image' && selectedReferences.length > 0 && (
              <UiButton
                size="sm"
                onClick={openAssetPicker}
                className="w-full"
                title="替换源图"
              >
                替换源图
              </UiButton>
            )}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-col gap-4 p-6">
        <div className="relative">
          <UiTextArea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder={sourceMode === 'image'
              ? '可选备注：使用现成图片作为全景源，不会提交给 AI'
              : '输入全景场景描述；按 @ 可插入图1/图2引用，文字+图片+内置全景提示词会一起提交'}
            className="nodrag nowheel h-40 w-full resize-none px-4 py-3 text-sm leading-6"
          />
          {showReferencePicker && selectedReferences.length > 0 && (
            <div className="absolute left-3 top-11 z-30 w-[180px] overflow-hidden rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]">
              <div className="ui-scrollbar max-h-[220px] overflow-y-auto p-1.5">
                {selectedReferences.map((image, index) => (
                  <UiButton
                    key={`${image.id}-mention-${index}`}
                    variant="ghost"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertPanoramaReference(index)}
                    onMouseEnter={() => setReferencePickerIndex(index)}
                    className={`h-auto w-full justify-start rounded-lg px-2 py-2 text-left text-xs ${
                      referencePickerIndex === index ? 'bg-[var(--press)] text-text-dark' : ''
                    }`}
                  >
                    <AssetMedia kind="image" source={image.url} alt={image.label} className="h-8 w-8 rounded-sm object-cover" draggable={false} />
                    <span className="min-w-0 flex-1 truncate">@图{index + 1}</span>
                  </UiButton>
                ))}
              </div>
            </div>
          )}
        </div>
        {sourceMode === 'ai' || sourceMode === 'text' ? (
          <div className="rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-subtle-bg) px-3 py-2 text-[11px] leading-5 text-text-muted">
            AI生成全景图会把文字、导入图片和内置全景提示词一起提交，目标是先得到 2:1 全景底图，再进入全景查看器。
          </div>
        ) : (
          <div className="rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-subtle-bg) px-3 py-2 text-[11px] leading-5 text-text-muted">
            图生全景图只使用第一张源图作为全景底图。图片接近 {projection === 'spherical' ? '2:1' : '4:1'} 时直接进入全景查看器；不符合时在本地裁切、羽化并归一化，不会提交给 AI。
          </div>
        )}
        {sourceMode !== 'image' && (
          <details className="text-[11px] text-text-muted">
            <summary className="cursor-pointer hover:text-text-dark">查看最终提示词</summary>
            <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-(--canvas-node-field-bg) p-2 text-[11px] text-text-muted">{composed}</pre>
          </details>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-(--canvas-node-divider) pt-4">
          {sourceMode !== 'image' ? (
            <ModelConfigPicker
              panelKey="panorama"
              preferredRatio={projection === 'spherical' ? '2:1' : '4:1'}
            />
          ) : (
            <div className="text-[11px] leading-5 text-text-muted">
              使用现成图片作为全景源，比例处理在本地完成。
            </div>
          )}
          <div className="flex items-center gap-2">
            <UiButton
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={sourceMode === 'image' && !directReference}
              className="whitespace-nowrap"
              icon={sourceMode === 'image' ? <ImageIcon className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
            >
              {sourceMode === 'image' ? '创建全景图' : '生成全景图'}
            </UiButton>
          </div>
        </div>
      </main>

      <aside className="flex flex-col gap-4 border-l border-(--canvas-node-divider) bg-(--canvas-node-subtle-bg) p-4">
        <section className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">生成方式</div>
          {modeButtons}
        </section>
        <section className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">投影方式</div>
          {projectionButtons}
        </section>
        {projection === 'cylindrical' && (
          <div className="rounded-md border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-5 text-warning">
            360° 环绕更适合横向街景/长廊；普通全景建议使用 720° 球体。
          </div>
        )}
        <section className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">比例兜底</div>
          <div className="flex items-start gap-2 rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-bg-strong) px-3 py-2 text-[11px] leading-5 text-text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span>
              {sourceMode === 'image'
                ? `本地检查源图比例；符合 ${projection === 'spherical' ? '2:1' : '4:1'} 时直接使用，不符合时本地裁切、羽化并归一化。`
                : `会优先请求 ${projection === 'spherical' ? '2:1' : '4:1'} 全景比例；如果当前供应商不支持，会自动改用最接近的宽比例，并在生成后走裁切/归一化兜底。`}
            </span>
          </div>
          {sourceMode !== 'image' && (
            <div className="flex flex-col gap-2 pt-1">
              {smartControl}
              <UiButton
                size="sm"
                onClick={() => onCopyPrompt?.(composed)}
                icon={<Copy className="h-3.5 w-3.5" />}
                title="复制完整提示词到剪贴板"
              >
                复制提示词
              </UiButton>
            </div>
          )}
        </section>
      </aside>
    </div>
  );

  if (compact) {
    return <div className="p-3">{body}</div>;
  }

  return (
    <>
      {body}
      {isAssetPickerOpen && (
        <div className="absolute inset-0 z-260 flex items-center justify-center bg-[var(--scrim)] backdrop-blur-xs">
          <div className="w-[560px] max-w-[calc(100%-32px)] rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]">
            <div className="flex items-center justify-between border-b border-(--canvas-node-divider) px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-text-dark">{sourceMode === 'image' ? '选择要转换的全景源图' : '选择全景参考图'}</div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  {sourceMode === 'image'
                    ? '图生全景图只使用一张现成图片作为全景源，不会提交给 AI'
                    : 'AI生成全景图支持多选，可作为风格 / 主体 / 元素参考'}
                </div>
              </div>
              <UiIconButton onClick={() => setIsAssetPickerOpen(false)} aria-label="关闭">
                <X className="h-4 w-4" />
              </UiIconButton>
            </div>
            <div className="border-b border-(--canvas-node-divider) px-4 py-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
                <UiInput
                  value={assetQuery}
                  onChange={(event) => setAssetQuery(event.target.value)}
                  placeholder="搜索图片名称"
                  aria-label="搜索图片名称"
                  className="h-8 w-full pl-8 text-xs"
                />
              </label>
            </div>
            <div className="ui-scrollbar max-h-[380px] overflow-y-auto p-4">
              {filteredReferences.length === 0 ? (
                <div className="rounded-lg border border-dashed border-(--canvas-node-border) px-4 py-10 text-center text-xs text-text-muted">
                  没有匹配的图片资产
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {filteredReferences.map((image) => {
                    const selected = draftSelectedIds.includes(image.id);
                    return (
                      <UiButton
                        key={image.id}
                        aria-pressed={selected}
                        onClick={() => toggleDraftReference(image.id)}
                        className={`relative h-auto flex-col items-stretch gap-0 overflow-hidden rounded-lg p-0 text-left ${
                          selected ? 'ring-1 ring-accent/50' : ''
                        }`}
                      >
                        <div className="aspect-square bg-(--canvas-node-media-bg)">
                          <AssetMedia kind="image" source={image.url} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                        </div>
                        <div className="truncate px-1.5 py-1 text-[10px] text-text-dark">{image.label}</div>
                        {selected && <UiBadge tone="accent" className="absolute right-1 top-1 text-[9px]">已选</UiBadge>}
                      </UiButton>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-(--canvas-node-divider) px-4 py-3">
              <UiButton size="sm" onClick={() => setIsAssetPickerOpen(false)}>
                取消
              </UiButton>
              <UiButton
                variant="primary"
                size="sm"
                onClick={confirmAssetPicker}
                disabled={sourceMode === 'image' && draftSelectedIds.length === 0}
              >
                {sourceMode === 'image'
                  ? (draftSelectedIds.length > 0 ? '使用此图' : '请选择一张源图')
                  : `加入 ${draftSelectedIds.length} 张`}
              </UiButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

PanoramaSetupForm.displayName = 'PanoramaSetupForm';
