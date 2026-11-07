import { Aperture, ImagePlus, Maximize2, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import { StageEmpty } from './stageKit';

/** Captured frames: the current one large, history as a strip, and the hand-off to the canvas. */
export function StageSnapshotsPanel({
  current,
  history,
  resolveUrl,
  captureKeys,
  canAddToCanvas,
  busy,
  onCapture,
  onSelect,
  onDelete,
  onOpen,
  onClearCurrent,
  onClearAll,
  onAddCurrent,
  onAddAll,
}: {
  current: string | null;
  history: string[];
  resolveUrl: (url: string) => string;
  captureKeys: string;
  canAddToCanvas: boolean;
  busy: boolean;
  onCapture: () => void;
  onSelect: (url: string) => void;
  onDelete: (url: string) => void;
  onOpen: (url: string) => void;
  onClearCurrent: () => void;
  onClearAll: () => void;
  onAddCurrent: () => void;
  onAddAll: () => void;
}) {
  const { t } = useTranslation();
  if (!current && history.length === 0) {
    return (
      <StageEmpty
        icon={<Aperture className="h-5 w-5" />}
        title={t('directorStudio.dock.noSnapshots')}
        hint={t('directorStudio.dock.noSnapshotsHint', { keys: captureKeys })}
        action={<UiButton size="sm" variant="secondary" onClick={onCapture} className="mt-2"><Aperture className="h-3.5 w-3.5" />{t('directorStudio.toolbar.screenshot')}</UiButton>}
      />
    );
  }
  return (
    <div className="space-y-3 px-3.5 pb-4 pt-1">
      {current ? (
        <div className="group relative overflow-hidden rounded-xl bg-black/40 shadow-[0_0_0_1px_var(--line-strong)]">
          <button type="button" onClick={() => onOpen(current)} className="block w-full" aria-label={t('directorStudio.openSnapshotLightbox')}>
            <img src={resolveUrl(current)} alt={t('directorStudio.snapshotPreview')} className="aspect-video w-full object-contain" draggable={false} />
          </button>
          <span className="pointer-events-none absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg bg-black/55 text-white/85 opacity-0 transition-opacity group-hover:opacity-100"><Maximize2 className="h-3.5 w-3.5" /></span>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        <UiButton size="sm" variant="accent" onClick={onAddCurrent} disabled={!current || !canAddToCanvas || busy} data-director-tooltip={t('directorStudio.addToCanvasTitle')}>
          <Plus className="h-3.5 w-3.5" />{t('directorStudio.addToCanvas')}
        </UiButton>
        <UiButton size="sm" variant="secondary" onClick={onAddAll} disabled={history.length === 0 || !canAddToCanvas || busy} data-director-tooltip={t('directorStudio.addAllToCanvasTitle')}>
          <ImagePlus className="h-3.5 w-3.5" />{t('directorStudio.addAllToCanvas')}
        </UiButton>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
          <span>{t('directorStudio.snapshotHistory')}</span>
          <span className="font-mono normal-case tracking-normal">{t('directorStudio.snapshotCount', { count: history.length })}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[...history].reverse().map((url) => {
            const index = history.indexOf(url);
            const isCurrent = url === current;
            return (
              <div key={`${url.slice(0, 48)}-${index}`} className={`group relative aspect-video overflow-hidden rounded-lg bg-black/40 transition-shadow ${isCurrent ? 'shadow-[0_0_0_1.5px_rgb(var(--accent-rgb))]' : 'shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line-strong)]'}`}>
                <button type="button" onClick={() => onSelect(url)} className="block h-full w-full" aria-label={t('directorStudio.snapshotThumbnail', { count: index + 1 })}>
                  <img src={resolveUrl(url)} alt="" className="h-full w-full object-cover" draggable={false} />
                </button>
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1 font-mono text-[9px] text-white/80">{index + 1}</span>
                <UiIconButton size="sm" onClick={() => onDelete(url)} className="absolute right-0.5 top-0.5 h-6 w-6 bg-black/55 text-white/85 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100" aria-label={t('directorStudio.deleteSnapshot')} data-director-tooltip={t('directorStudio.deleteSnapshot')}>
                  <X className="h-3 w-3" />
                </UiIconButton>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-between gap-1.5 border-t border-[var(--line)] pt-3">
        <UiButton size="sm" variant="ghost" onClick={onClearCurrent} disabled={!current}>{t('directorStudio.clearCurrentSnapshot')}</UiButton>
        <UiButton size="sm" variant="ghost" onClick={onClearAll} disabled={history.length === 0} className="text-danger hover:text-danger"><Trash2 className="h-3.5 w-3.5" />{t('directorStudio.clearAllSnapshots')}</UiButton>
      </div>
    </div>
  );
}
