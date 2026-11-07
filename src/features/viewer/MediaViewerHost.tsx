import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Copy, Download, LoaderCircle, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useAssetDisplaySource } from '@/features/assets/ui/useAssetDisplaySource';
import { downloadAssetSource } from '@/features/assets/ui/AssetMedia';
import { closeMediaViewer, stepMediaViewer, useMediaViewerStore, type MediaViewerAction, type MediaViewerItem } from './viewerStore';

export function MediaViewerHost() {
  const state = useMediaViewerStore();
  const item = state.items[state.index];
  return state.open && item ? <MediaViewer item={item} index={state.index} count={state.items.length} /> : null;
}

function MediaViewer({ item, index, count }: { item: MediaViewerItem; index: number; count: number }) {
  const { t } = useTranslation();
  const { url, error } = useAssetDisplaySource(item.source);
  const { dialogRef, onKeyDown } = useModalFocus({ isOpen: true, onClose: closeMediaViewer });
  const [mediaError, setMediaError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const activeItem = useRef(item.id);
  activeItem.current = item.id;
  const pendingRef = useRef(false);
  useEffect(() => { setZoom(1); setOffset({ x: 0, y: 0 }); setMediaError(false); setFeedback(''); setFailure(''); }, [item.id]);
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (action: MediaViewerAction) => {
    if (pendingRef.current || action.disabled) return;
    const itemId = item.id; pendingRef.current = true;
    setPending(action.id); setFailure('');
    try { await action.run(); }
    catch (cause) { if (alive.current && activeItem.current === itemId) setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { pendingRef.current = false; if (alive.current) setPending(null); }
  };
  const actions: MediaViewerAction[] = [{ id: 'download', label: t('rework.download'), icon: <Download />, run: () => downloadAssetSource(item.source, item.title) }, ...(item.actions ?? []).filter((action) => action.id !== 'download')];
  const resize = (next: number) => { setZoom(Math.max(1, Math.min(5, next))); if (next <= 1) setOffset({ x: 0, y: 0 }); };
  return createPortal(
    <div className="media-viewer" ref={dialogRef} role="dialog" aria-modal="true" aria-label={item.title || t('ui.viewer.title')} tabIndex={-1}
      onKeyDown={(event) => {
        onKeyDown(event);
        if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepMediaViewer(event.key === 'ArrowLeft' ? -1 : 1); }
      }}>
      <header className="media-viewer__header">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.title || t('ui.viewer.title')}</p><p className="text-xs text-text-muted">{t('ui.viewer.position', { index: index + 1, count })}</p></div>
        <UiIconButton aria-label={t('common.close')} title={t('common.close')} onClick={closeMediaViewer}><X /></UiIconButton>
      </header>
      <div className="media-viewer__body">
        <div className="media-viewer__stage">
          <div className="media-viewer__image" data-zoomed={zoom > 1 || undefined}
            onWheel={item.kind === 'image' ? (event) => { event.stopPropagation(); resize(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)); } : undefined}
            onPointerDown={(event) => { if (zoom <= 1 || item.kind !== 'image') return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y }; }}
            onPointerMove={(event) => { if (drag.current) setOffset({ x: drag.current.originX + event.clientX - drag.current.x, y: drag.current.originY + event.clientY - drag.current.y }); }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            onDoubleClick={() => resize(zoom === 1 ? 2 : 1)}>
            {error || mediaError ? <p role="alert" className="p-8 text-sm text-danger">{error || t('ui.viewer.mediaMissing')}</p> : !url ? <LoaderCircle className="animate-spin text-text-muted" />
              : item.kind === 'image' ? <img src={url} onError={() => setMediaError(true)} alt={item.title ?? ''} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }} />
                : item.kind === 'video' ? <video src={url} onError={() => setMediaError(true)} controls playsInline autoPlay={false} /> : <audio src={url} onError={() => setMediaError(true)} controls />}
          </div>
          {count > 1 && <div className="media-viewer__navigation"><UiIconButton disabled={index === 0} title={t('ui.viewer.previous')} aria-label={t('ui.viewer.previous')} onClick={() => stepMediaViewer(-1)}><ChevronLeft /></UiIconButton><UiIconButton disabled={index === count - 1} title={t('ui.viewer.next')} aria-label={t('ui.viewer.next')} onClick={() => stepMediaViewer(1)}><ChevronRight /></UiIconButton></div>}
          {item.kind === 'image' && <div className="media-viewer__zoom"><UiIconButton title={t('ui.viewer.zoomOut')} aria-label={t('ui.viewer.zoomOut')} disabled={zoom <= 1} onClick={() => resize(zoom / 1.25)}><ZoomOut /></UiIconButton><span className="min-w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span><UiIconButton title={t('ui.viewer.zoomIn')} aria-label={t('ui.viewer.zoomIn')} disabled={zoom >= 5} onClick={() => resize(zoom * 1.25)}><ZoomIn /></UiIconButton><UiIconButton title={t('ui.viewer.fit')} aria-label={t('ui.viewer.fit')} onClick={() => resize(1)}><Maximize /></UiIconButton></div>}
        </div>
        <aside className="media-viewer__details ui-scrollbar">
          {item.prompt && <section><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-medium">{t('ui.viewer.prompt')}</h3><UiIconButton aria-label={t('rework.copyPrompt')} title={t('rework.copyPrompt')} onClick={() => void run({ id: 'copy', label: '', run: async () => { await navigator.clipboard.writeText(item.prompt!); if (alive.current) setFeedback(t('rework.copied')); } })}><Copy /></UiIconButton></div><p className="whitespace-pre-wrap break-words text-sm leading-7 text-text-muted">{item.prompt}</p></section>}
          {item.facts?.length ? <dl className="media-viewer__facts">{item.facts.map((fact, i) => <div key={`${fact.label}-${i}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl> : null}
          <section><h3 className="mb-3 text-sm font-medium">{t('ui.viewer.actions')}</h3><div className="grid grid-cols-2 gap-2">
            {actions.map((action) => <UiButton key={action.id} variant="secondary" className="min-h-10 text-xs" icon={action.icon} disabled={Boolean(pending) || action.disabled} title={action.disabledReason} loading={pending === action.id} onClick={() => void run(action)}>{action.label}</UiButton>)}
          </div></section>
          {item.primaryActions?.map((action) => <UiButton key={action.id} variant="primary" className="min-h-11 w-full" disabled={Boolean(pending) || action.disabled} loading={pending === action.id} onClick={() => void run(action)}>{action.label}</UiButton>)}
          {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}{feedback && <p role="status" className="text-sm text-success">{feedback}</p>}
          <p className="mt-auto pt-4 text-xs text-text-subtle">{t('ui.viewer.keys')}</p>
        </aside>
      </div>
    </div>, document.body,
  );
}
