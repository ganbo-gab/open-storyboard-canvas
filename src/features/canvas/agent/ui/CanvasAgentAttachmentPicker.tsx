import { useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, LoaderCircle, Search, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
      className="agent-view-enter absolute inset-x-3 bottom-[calc(100%+8px)] z-30 flex max-h-[min(430px,62vh)] flex-col overflow-hidden rounded-[6px] border border-border-dark bg-bg-dark shadow-2xl"
      aria-label={t('canvasAgent.attachmentPicker')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border-dark px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.attachmentPicker')}</div>
          <div className="mt-0.5 text-[10px] text-text-muted">
            {t('canvasAgent.attachmentCount', { count: attachmentCount, max: maxAttachments })}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] text-text-muted transition-colors hover:bg-text-dark/[0.05] hover:text-text-dark"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-border-dark p-3">
        <button
          type="button"
          disabled={!selectedNodeHasImage || attachmentCount >= maxAttachments}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[5px] border border-border-dark px-2 text-xs text-text-dark transition-[background-color,transform] hover:bg-text-dark/[0.05] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onAttachSelected}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {t('canvasAgent.attachSelected')}
        </button>
        <button
          type="button"
          disabled={isUploading || attachmentCount >= maxAttachments}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[5px] border border-border-dark px-2 text-xs text-text-dark transition-[background-color,transform] hover:bg-text-dark/[0.05] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading
            ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <Upload className="h-4 w-4" aria-hidden="true" />}
          {isUploading ? t('canvasAgent.uploadingAttachment') : t('canvasAgent.uploadAttachment')}
        </button>
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

      <label className="mx-3 mt-3 flex h-10 shrink-0 items-center gap-2 rounded-[5px] border border-border-dark px-2 text-text-muted focus-within:border-accent/60">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t('canvasAgent.searchAttachments')}</span>
        <input
          id="canvas-agent-asset-search"
          name="canvas-agent-asset-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted/70"
          placeholder={t('canvasAgent.searchAttachments')}
        />
        {query ? (
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-text-dark/[0.05] hover:text-text-dark"
            aria-label={t('common.clear')}
            onClick={() => setQuery('')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </label>

      {error ? (
        <div className="mx-3 mt-2 rounded-[4px] border border-red-500/30 bg-red-500/[0.07] px-2.5 py-2 text-[11px] leading-5 text-red-700 dark:text-red-200" role="alert">
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
                  className={`group relative overflow-hidden rounded-[5px] border text-left transition-[border-color,background-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected
                      ? 'border-accent bg-accent/[0.10]'
                      : 'border-border-dark bg-text-dark/[0.025] hover:border-accent/50'
                  }`}
                  title={asset.title}
                  aria-pressed={selected}
                  onClick={() => onToggle(asset)}
                >
                  <span className="block aspect-square overflow-hidden bg-black/15">
                    <img
                      src={resolveImageDisplayUrl(asset.previewUrl || asset.url)}
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                      draggable={false}
                    />
                  </span>
                  <span className="block truncate px-1.5 py-1.5 text-[10px] text-text-dark">{asset.title}</span>
                  {selected ? (
                    <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white shadow">
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
