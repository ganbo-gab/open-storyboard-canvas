import { useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, LoaderCircle, Search, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import type { CanvasAssetCatalogItem } from '@/features/canvas/application/canvasAssetCatalog';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

interface Props {
  assets: CanvasAssetCatalogItem[];
  selectedAssetIds: string[];
  attachmentCount: number;
  selectedNodeId: string | null;
  maxAttachments: number;
  isUploading: boolean;
  error?: string | null;
  onToggle: (asset: CanvasAssetCatalogItem) => void;
  onAttachSelected: () => void;
  onUpload: (files: File[]) => void;
  onClose: () => void;
}

export function CanvasAgentAttachmentPicker({
  assets,
  selectedAssetIds,
  attachmentCount,
  selectedNodeId,
  maxAttachments,
  isUploading,
  error,
  onToggle,
  onAttachSelected,
  onUpload,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedIds = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);
  const selectedNodeHasImage = assets.some((asset) => asset.nodeId === selectedNodeId);
  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return assets
      .slice()
      .sort((left, right) => right.order - left.order)
      .filter((asset) => !normalized
        || `${asset.title} ${asset.sourceLabel}`.toLowerCase().includes(normalized));
  }, [assets, query]);

  return (
    <section
      className="agent-view-enter absolute inset-x-3 bottom-[calc(100%+8px)] z-30 flex max-h-[min(430px,62vh)] flex-col overflow-hidden rounded-[6px] border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]"
      aria-label={t('canvasAgent.attachmentPicker')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.attachmentPicker')}</div>
          <div className="mt-0.5 text-[10px] text-text-muted">
            {t('canvasAgent.attachmentCount', { count: attachmentCount, max: maxAttachments })}
          </div>
        </div>
        <UiIconButton
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </UiIconButton>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-[var(--line)] p-3">
        <UiButton
          variant="secondary"
          disabled={!selectedNodeHasImage || attachmentCount >= maxAttachments}
          className="min-h-11 gap-2 px-2 text-xs"
          onClick={onAttachSelected}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {t('canvasAgent.attachSelected')}
        </UiButton>
        <UiButton
          variant="secondary"
          disabled={isUploading || attachmentCount >= maxAttachments}
          className="min-h-11 gap-2 px-2 text-xs"
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading
            ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <Upload className="h-4 w-4" aria-hidden="true" />}
          {isUploading ? t('canvasAgent.uploadingAttachment') : t('canvasAgent.uploadAttachment')}
        </UiButton>
        <input
          ref={fileInputRef}
          id="canvas-agent-image-upload"
          name="canvas-agent-image-upload"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          multiple
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) onUpload(files);
          }}
        />
      </div>

      <label className="ui-input mx-3 mt-3 h-10 shrink-0 gap-2 px-2 text-text-muted focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t('canvasAgent.searchAttachments')}</span>
        <input
          id="canvas-agent-asset-search"
          name="canvas-agent-asset-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-hidden"
          placeholder={t('canvasAgent.searchAttachments')}
        />
        {query ? (
          <UiIconButton
            aria-label={t('common.clear')}
            onClick={() => setQuery('')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </UiIconButton>
        ) : null}
      </label>

      {error ? (
        <div className="mx-3 mt-2 rounded-[4px] border border-danger/30 bg-danger/[0.07] px-2.5 py-2 text-[11px] leading-5 text-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {filteredAssets.length ? (
          <div className="grid grid-cols-3 gap-2">
            {filteredAssets.map((asset) => {
              const selected = selectedIds.has(asset.id);
              const disabled = !selected && attachmentCount >= maxAttachments;
              return (
                <button
                  key={asset.id}
                  type="button"
                  disabled={disabled}
                  className={`group relative overflow-hidden rounded-[5px] border text-left transition-[border-color,background-color,transform,translate,scale,rotate] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected
                      ? 'border-accent bg-accent/10 hover:bg-accent/15'
                      : 'border-[var(--line)] bg-[var(--field-bg)] hover:border-accent/50'
                  }`}
                  title={asset.title}
                  aria-pressed={selected}
                  onClick={() => onToggle(asset)}
                >
                  <span className="block aspect-square overflow-hidden bg-[var(--canvas-node-media-bg)]">
                    <img
                      src={resolveImageDisplayUrl(asset.previewUrl || asset.url)}
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                      draggable={false}
                    />
                  </span>
                  <span className="block truncate px-1.5 py-1.5 text-[10px] text-text-dark">{asset.title}</span>
                  {selected ? (
                    <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[var(--accent-fg)] shadow-sm">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-32 items-center justify-center px-4 text-center text-xs leading-5 text-text-muted">
            {query ? t('canvasAgent.noMatchingAttachments') : t('canvasAgent.noCanvasImages')}
          </div>
        )}
      </div>
    </section>
  );
}
