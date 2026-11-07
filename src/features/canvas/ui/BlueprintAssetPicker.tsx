import { UiButton, UiIconButton } from '@/components/ui';
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
      className="absolute inset-0 z-260 flex items-center justify-center bg-[var(--scrim)] backdrop-blur-xs"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="nodrag nopan w-[560px] max-w-[calc(100%-32px)] rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-text-dark">{title}</div>
            <div className="mt-0.5 text-[11px] text-text-subtle">{subtitle}</div>
          </div>
          <UiIconButton size="sm" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X className="h-4 w-4" />
          </UiIconButton>
        </div>

        <div className="border-b border-[var(--line)] px-4 py-2">
          <label className="ui-input flex h-8 items-center gap-2 px-2 focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/20">
            <Search className="h-3.5 w-3.5 text-text-subtle" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('blueprintAssetPicker.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-xs text-text-dark focus-visible:outline-none"
            />
          </label>
        </div>

        <div
          className="ui-scrollbar nowheel max-h-[380px] overflow-y-auto p-4"
          onWheel={(event) => event.stopPropagation()}
        >
          {images.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center text-xs text-text-subtle">
              {t('blueprintAssetPicker.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {images.map((image) => {
                const selected = selectedIds.includes(image.id);
                const displayUrl = resolveImageDisplayUrl(image.url) ?? image.url;
                return (
                  <UiButton
                    key={image.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onToggle(image.id)}
                    className={`relative block h-auto overflow-hidden rounded-lg p-0 text-left ${selected ? 'ring-2 ring-accent/60' : ''}`}
                  >
                    <div className="aspect-square bg-[var(--field-bg)]">
                    <img src={displayUrl} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                  </div>
                  <div className="truncate px-1.5 py-1 text-[10px] text-text-muted">{image.label}</div>
                  {selected && (
                    <span className="absolute right-1 top-1 rounded-sm bg-accent/20 px-1 py-0.5 text-[9px] text-accent">
                      {t('blueprintAssetPicker.selected')}
                    </span>
                  )}</UiButton>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
          <UiButton size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton size="sm" variant="primary" onClick={onConfirm}>
            {confirmText}
          </UiButton>
        </div>
      </div>
    </div>
  );
});
