import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

import type { BlueprintReferenceImage } from '@/features/canvas/application/blueprintPrompt';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

/**
 * Modal that picks one or more reference images out of a known asset pool.
 * Used by both `BlueprintNode` (canvas-embedded) and `BlueprintPanel`
 * (legacy popup). The component is purely presentational — selection state,
 * filtering, and the meaning of "confirm" all live in the parent.
 */
export interface BlueprintAssetPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** All assets available to choose from (already deduplicated by parent). */
  images: BlueprintReferenceImage[];
  /** Currently-selected image ids. */
  selectedIds: string[];
  /** User clicked an image. Parent decides if this toggles, replaces, etc. */
  onToggle: (imageId: string) => void;
  onConfirm: () => void;
  query: string;
  onQueryChange: (next: string) => void;
  title?: string;
  subtitle?: string;
  /** Custom label generator for the confirm button. */
  confirmLabel?: (count: number) => string;
}

export const BlueprintAssetPicker = memo(function BlueprintAssetPicker(props: BlueprintAssetPickerProps) {
  const { t } = useTranslation();
  const {
    isOpen,
    onClose,
    images,
    selectedIds,
    onToggle,
    onConfirm,
    query,
    onQueryChange,
  } = props;
  const title = props.title ?? t('blueprintAssetPicker.title');
  const subtitle = props.subtitle ?? t('blueprintAssetPicker.subtitle');
  const confirmText = props.confirmLabel?.(selectedIds.length)
    ?? t('blueprintAssetPicker.confirm', { count: selectedIds.length });

  if (!isOpen) return null;

  return (
    <div
      className="absolute inset-0 z-260 flex items-center justify-center bg-black/55 backdrop-blur-xs"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="nodrag nopan w-[560px] max-w-[calc(100%-32px)] rounded-xl border border-white/14 bg-[#181818] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-white">{title}</div>
            <div className="mt-0.5 text-[11px] text-white/42">{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-white/8 px-4 py-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-black/22 px-2">
            <Search className="h-3.5 w-3.5 text-white/35" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('blueprintAssetPicker.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-xs text-white/85 outline-hidden placeholder:text-white/30"
            />
          </label>
        </div>

        <div
          className="ui-scrollbar nowheel max-h-[380px] overflow-y-auto p-4"
          onWheel={(event) => event.stopPropagation()}
        >
          {images.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/12 px-4 py-10 text-center text-xs text-white/45">
              {t('blueprintAssetPicker.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {images.map((image) => {
                const selected = selectedIds.includes(image.id);
                const displayUrl = resolveImageDisplayUrl(image.url) ?? image.url;
                return (
                  <button
                    key={image.id}
                    type="button"
                    onClick={() => onToggle(image.id)}
                    className={`relative overflow-hidden rounded-lg border bg-white/4 text-left transition-colors ${
                      selected ? 'border-accent/80 ring-1 ring-accent/50' : 'border-white/10 hover:border-white/[0.28]'
                    }`}
                  >
                    <div className="aspect-square bg-black/25">
                      <img src={displayUrl} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                    </div>
                    <div className="truncate px-1.5 py-1 text-[10px] text-white/76">{image.label}</div>
                    {selected && (
                      <span className="absolute right-1 top-1 rounded-sm bg-accent px-1 py-0.5 text-[9px] text-white">
                        {t('blueprintAssetPicker.selected')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/8 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/75 hover:bg-white/14"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-white px-3 py-1.5 text-xs text-black hover:bg-gray-100"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
});
