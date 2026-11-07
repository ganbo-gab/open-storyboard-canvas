import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Copy,
  Crop,
  Crosshair,
  Eye,
  EyeOff,
  Maximize2,
  PersonStanding,
  PictureInPicture2,
  RotateCcw,
  Route,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiSegmented } from '@/components/ui';

export interface StageSelectionSummary {
  label: string;
  color: string;
  kindLabel: string;
  isPerson: boolean;
}

function BarButton({ label, keys, active, onClick, children }: { label: string; keys?: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="stage-tool h-8 w-8" data-active={active || undefined} aria-pressed={active} aria-label={label} data-director-tooltip={label} data-director-tooltip-keys={keys} onClick={onClick}>
      {children}
    </button>
  );
}

/** Top-right view controls: preview source, routes, safe frame, framing. */
export function StageViewBar({
  previs,
  frame,
  frames,
  hasSelection,
  following,
  keys,
  onPreviewMode,
  onShowRoutes,
  onShowPip,
  onFrame,
  onFocus,
  onFit,
  onReset,
}: {
  previs: { previewMode: 'route' | 'shot'; showRoutes: boolean; showPip: boolean } | null;
  frame: string;
  frames: Array<{ value: string; label: string }>;
  hasSelection: boolean;
  following: boolean;
  keys: { focus: string; fit: string; reset: string };
  onPreviewMode: (mode: 'route' | 'shot') => void;
  onShowRoutes: (show: boolean) => void;
  onShowPip: (show: boolean) => void;
  onFrame: (value: string) => void;
  onFocus: () => void;
  onFit: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [frameOpen, setFrameOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!frameOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setFrameOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFrameOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [frameOpen]);
  const frameLabel = frames.find((entry) => entry.value === frame)?.label ?? frame;

  return (
    <div className="stage-glass pointer-events-auto absolute right-3 top-3 z-30 flex items-center gap-1 rounded-xl p-1">
      {previs ? (
        <>
          <UiSegmented
            value={previs.previewMode}
            onChange={onPreviewMode}
            size="sm"
            aria-label={t('directorStudio.previs.previewSource')}
            options={[
              { value: 'route', icon: <Route size={14} />, label: t('directorStudio.motion.timeline.routePreview'), buttonProps: { 'data-director-tooltip': t('directorStudio.previs.routeViewHelp') } },
              { value: 'shot', icon: <Clapperboard size={14} />, label: t('directorStudio.motion.timeline.shotPreview'), buttonProps: { 'data-director-tooltip': t('directorStudio.previs.shotViewHelp') } },
            ]}
          />
          <BarButton label={t(previs.showRoutes ? 'directorStudio.motion.timeline.hideRoutes' : 'directorStudio.motion.timeline.showRoutes')} active={previs.showRoutes} onClick={() => onShowRoutes(!previs.showRoutes)}>
            {previs.showRoutes ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </BarButton>
          {previs.previewMode === 'route' ? (
            <BarButton label={t(previs.showPip ? 'directorStudio.previs.pip.hide' : 'directorStudio.previs.pip.show')} active={previs.showPip} onClick={() => onShowPip(!previs.showPip)}>
              <PictureInPicture2 className="h-4 w-4" />
            </BarButton>
          ) : null}
          <span className="mx-0.5 h-5 w-px bg-[var(--line-strong)]" />
        </>
      ) : null}
      <div ref={menuRef} className="relative">
        <button type="button" className="stage-chip h-8 px-2.5 font-mono text-[11px]" aria-haspopup="listbox" aria-expanded={frameOpen} data-director-tooltip={t('directorStudio.frameHelp')} onClick={() => setFrameOpen((open) => !open)}>
          <Crop className="h-3.5 w-3.5" />{frameLabel}<ChevronDown className="h-3 w-3 opacity-60" />
        </button>
        {frameOpen ? (
          <div role="listbox" data-stage-popover aria-label={t('directorStudio.toolbar.frame')} className="stage-glass stage-pop absolute right-0 top-[calc(100%+6px)] grid w-44 grid-cols-1 gap-0.5 rounded-xl p-1">
            {frames.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="option"
                aria-selected={entry.value === frame}
                className="flex h-8 items-center justify-between rounded-lg px-2.5 text-left text-xs text-text-muted transition-colors hover:bg-[var(--hover)] hover:text-text-dark aria-selected:text-text-dark"
                onClick={() => { onFrame(entry.value); setFrameOpen(false); }}
              >
                {entry.label}
                {entry.value === frame ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="mx-0.5 h-5 w-px bg-[var(--line-strong)]" />
      {hasSelection ? (
        <BarButton label={t(following ? 'directorStudio.view.stopFollow' : 'directorStudio.view.focus')} keys={keys.focus} active={following} onClick={onFocus}>
          <Crosshair className="h-4 w-4" />
        </BarButton>
      ) : null}
      <BarButton label={t('directorStudio.scene.fitAllTitle')} keys={keys.fit} onClick={onFit}><Maximize2 className="h-4 w-4" /></BarButton>
      <BarButton label={t('directorStudio.scene.resetView')} keys={keys.reset} onClick={onReset}><RotateCcw className="h-4 w-4" /></BarButton>
    </div>
  );
}

/**
 * Bottom-centre status: what the next click will do. Route drawing and pose editing
 * take over the slot; otherwise it carries the selection and its quick actions.
 */
export function StageStatusPill({
  routeDraft,
  pose,
  selection,
  keys,
  onFinishRoute,
  onCancelRoute,
  onExitPose,
  onPose,
  onDuplicate,
  onDelete,
  onDeselect,
}: {
  routeDraft: { targetLabel: string; hint: string; canFinish: boolean } | null;
  pose: { targetLabel: string; jointLabel: string | null } | null;
  selection: StageSelectionSummary | null;
  keys: { pose: string; duplicate: string; delete: string };
  onFinishRoute: () => void;
  onCancelRoute: () => void;
  onExitPose: () => void;
  onPose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeselect: () => void;
}) {
  const { t } = useTranslation();
  if (routeDraft) {
    return (
      <div role="status" className="stage-glass stage-pop pointer-events-auto flex max-w-[min(640px,calc(100%-24px))] items-center gap-3 rounded-2xl py-2 pl-4 pr-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inset-0 animate-ping rounded-full bg-warning/70" /><span className="relative h-2.5 w-2.5 rounded-full bg-warning" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-text-dark">{t('directorStudio.previs.drawingFor', { name: routeDraft.targetLabel })}</p>
          <p className="truncate text-[11px] text-text-muted">{routeDraft.hint}</p>
        </div>
        {routeDraft.canFinish ? (
          <button type="button" className="stage-chip h-8 bg-accent px-3 text-[var(--accent-fg)] hover:bg-accent hover:text-[var(--accent-fg)]" onClick={onFinishRoute}><Check className="h-3.5 w-3.5" />{t('directorStudio.motion.route.finish')}</button>
        ) : null}
        <button type="button" className="stage-chip h-8 px-2.5" onClick={onCancelRoute} aria-label={t('directorStudio.motion.route.cancel')}><X className="h-3.5 w-3.5" />Esc</button>
      </div>
    );
  }
  if (pose) {
    return (
      <div role="status" className="stage-glass stage-pop pointer-events-auto flex items-center gap-3 rounded-2xl py-1.5 pl-3 pr-1.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-[var(--accent-fg)]"><PersonStanding className="h-4 w-4" /></span>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-text-dark">{t('directorStudio.pose.editing', { name: pose.targetLabel })}</p>
          <p className="truncate text-[11px] text-text-muted">{pose.jointLabel ? t('directorStudio.pose.jointSelected', { joint: pose.jointLabel }) : t('directorStudio.pose.viewportHint')}</p>
        </div>
        <button type="button" className="stage-chip h-8 px-3 text-text-dark" onClick={onExitPose}><Check className="h-3.5 w-3.5" />{t('directorStudio.pose.done')}<kbd className="stage-kbd ml-1">Esc</kbd></button>
      </div>
    );
  }
  if (!selection) return null;
  return (
    <div className="stage-glass stage-pop pointer-events-auto flex items-center gap-1 rounded-2xl p-1 pl-2.5" aria-label={t('directorStudio.selection.label')}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_0_2px_rgb(0_0_0/0.35)]" style={{ backgroundColor: selection.color }} />
      <span className="max-w-[180px] truncate pl-1 text-xs font-semibold text-text-dark">{selection.label}</span>
      <span className="pr-1.5 text-[11px] text-text-subtle">{selection.kindLabel}</span>
      <span className="mx-0.5 h-5 w-px bg-[var(--line-strong)]" />
      {selection.isPerson ? (
        <BarButton label={t('directorStudio.pose.enter')} keys={keys.pose} onClick={onPose}><PersonStanding className="h-4 w-4" /></BarButton>
      ) : null}
      <BarButton label={t('directorStudio.selection.duplicate')} keys={keys.duplicate} onClick={onDuplicate}><Copy className="h-4 w-4" /></BarButton>
      <BarButton label={t('directorStudio.toolbar.delete')} keys={keys.delete} onClick={onDelete}><Trash2 className="h-4 w-4" /></BarButton>
      <BarButton label={t('directorStudio.selection.clear')} keys="Esc" onClick={onDeselect}><X className="h-4 w-4" /></BarButton>
    </div>
  );
}

/** Short-lived confirmation after a capture, with a jump to the snapshots tab. */
export function StageCaptureToast({ url, onOpen, onDismiss }: { url: string; onOpen: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 3600);
    return () => window.clearTimeout(timer);
  }, [onDismiss, url]);
  return (
    <div role="status" className="stage-glass stage-pop pointer-events-auto absolute bottom-3 right-3 z-30 flex items-center gap-2.5 rounded-2xl p-1.5 pr-2">
      <img src={url} alt="" className="h-12 w-20 rounded-lg object-cover shadow-[0_0_0_1px_var(--line-strong)]" draggable={false} />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-text-dark">{t('directorStudio.captured')}</p>
        <button type="button" onClick={onOpen} className="text-[11px] text-accent hover:underline">{t('directorStudio.viewSnapshots')}</button>
      </div>
    </div>
  );
}

const GUIDE_DONE_CLOSE_MS = 4000;
const GUIDE_DISMISSED_KEY = 'osc.stage.guideDismissed';

export function readStageGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStageGuideDismissed() {
  try {
    window.localStorage.setItem(GUIDE_DISMISSED_KEY, '1');
  } catch {
    // Storage unavailable: the guide stays hidden for this session only.
  }
}

/**
 * First-visit guide (spec 05 §2.4): place a person → draw a route → play. Each step is a shortcut to
 * the action and ticks off from the real scene state; closes itself a moment after the last step.
 */
export function StageGuideBar({ hasPerson, hasRoute, playback, onAddPerson, onDrawRoute, onPlay, onClose }: {
  hasPerson: boolean;
  hasRoute: boolean;
  playback: { subscribe: (listener: () => void) => () => void; getSnapshot: () => boolean };
  onAddPerson: () => void;
  onDrawRoute: () => void;
  onPlay: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const playing = useSyncExternalStore(playback.subscribe, playback.getSnapshot);
  const [played, setPlayed] = useState(false);
  useEffect(() => { if (playing && hasRoute) setPlayed(true); }, [hasRoute, playing]);
  const steps = [
    { key: 'person', done: hasPerson, onClick: onAddPerson },
    { key: 'route', done: hasRoute, onClick: onDrawRoute },
    { key: 'play', done: played, onClick: onPlay },
  ];
  const current = steps.findIndex((step) => !step.done);
  const allDone = current === -1;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!allDone) return;
    const timer = window.setTimeout(() => onCloseRef.current(), GUIDE_DONE_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [allDone]);
  return (
    <div role="group" aria-label={t('directorStudio.guide.title')} className="stage-glass stage-pop pointer-events-auto flex items-center gap-0.5 rounded-xl p-1 pl-3">
      <span className="pr-1.5 text-[11px] font-semibold text-text-dark">{t(allDone ? 'directorStudio.guide.done' : 'directorStudio.guide.title')}</span>
      {steps.map((step, index) => (
        <Fragment key={step.key}>
          {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0 text-text-subtle" aria-hidden="true" /> : null}
          <button
            type="button"
            className="stage-guide-step"
            data-state={step.done ? 'done' : index === current ? 'current' : 'todo'}
            data-director-tooltip={t(`directorStudio.guide.${step.key}Hint`)}
            onClick={step.onClick}
          >
            <span className="stage-guide-step__dot">{step.done ? <Check className="h-2.5 w-2.5" /> : index + 1}</span>
            {t(`directorStudio.guide.${step.key}`)}
          </button>
        </Fragment>
      ))}
      <button
        type="button"
        className="ml-1 grid h-7 w-7 place-items-center rounded-lg text-text-muted hover:bg-[var(--hover)] hover:text-text-dark"
        aria-label={t('directorStudio.guide.close')}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
