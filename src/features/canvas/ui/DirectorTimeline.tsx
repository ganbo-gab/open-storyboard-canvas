import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Camera, Copy, Diamond, Magnet, Minus, Pause, Play, Plus, Repeat2, SkipBack, Sparkles, Trash2, UserRound, X, ZoomIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BlueprintItem, DirectorMotionEasing, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import { DIRECTOR_MOTION_MAX_DURATION_SECONDS, DIRECTOR_MOTION_MIN_DURATION_SECONDS, retimeDirectorTrack } from '@/features/canvas/application/directorMotion';
import { PERSON_ACTIONS, PERSON_POSES } from '@/features/canvas/application/personMotionLibrary';
import { ScrubNumber } from '@/features/stage/ui/stageKit';
import type { DirectorKeyframePatch, DirectorKeyframeSelection } from './DirectorMotionInspector';
import type { DirectorKeyframeTrackRef } from './useDirectorStudioMotion';
import { snapStageTimelineTime } from '@/features/stage/application/timelineSnap';
import { StageRigTimeline, type StageRigTimelineActions } from '@/features/stage/ui/StageRigTimeline';

type Props = {
  height: number;
  maxHeight: number;
  onHeightChange: (height: number) => void;
  project: DirectorMotionProjectV1;
  items: BlueprintItem[];
  selectedItemId: string | null;
  timeSource: { subscribe: (listener: () => void) => () => void; getSnapshot: () => number };
  playbackSource: { subscribe: (listener: () => void) => () => void; getSnapshot: () => boolean };
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  selection: DirectorKeyframeSelection | null;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  onGoToStart: () => void;
  onLoopChange: (loop: boolean) => void;
  onDurationChange: (duration: number) => void;
  onSelectionChange: (selection: DirectorKeyframeSelection | null) => void;
  onSelectItem: (itemId: string) => void;
  onSelectCamera?: () => void;
  onMoveKeyframe: (selection: DirectorKeyframeSelection, time: number) => void;
  onCopyKeyframe: (selection: DirectorKeyframeSelection, time: number) => void;
  onPatchKeyframes: (ref: DirectorKeyframeTrackRef, keyframeIds: string[], patch: DirectorKeyframePatch) => void;
  onDeleteKeyframes: (ref: DirectorKeyframeTrackRef, keyframeIds: string[]) => void;
  onRetimeTrack: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onAddCameraKeyframe: () => void;
  onAddObjectKeyframe: (itemId: string) => void;
  onAddActionKeyframe: (itemId: string) => void;
  onSplitAtTime?: (kind: 'camera' | 'object' | 'action', trackId: string, time: number) => void;
  onCopyTrack?: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  rigActions?: StageRigTimelineActions;
};

type TrackFrame = { id: string; time: number; easing?: DirectorMotionEasing; actionId?: string | null; poseId?: string | null; clipId?: string | null; trackTargetId?: string | null };
type TrackRow = {
  key: string;
  kind: DirectorKeyframeSelection['kind'];
  trackId: string;
  label: string;
  keyframes: TrackFrame[];
  onAdd: () => void;
};

type DragOrigin = {
  pointerId: number;
  pointerStartX: number;
  scrollLeft: number;
  rect: DOMRect;
  selection: DirectorKeyframeSelection;
};
type DragState = DragOrigin & (
  | { mode: 'keyframe'; initialTime: number; time: number; copy: boolean }
  | {
      mode: 'track';
      kind: 'camera' | 'object';
      start: number;
      end: number;
      nextStart: number;
      nextEnd: number;
      handle: 'move' | 'start' | 'end';
      copy: boolean;
    }
);
/** Keyframes picked together in one row (Shift-click / Shift-drag); the inspector still edits `selection`. */
type MultiSelection = { rowKey: string; ids: string[] };
type Marquee = { rowKey: string; pointerId: number; rect: DOMRect; startX: number; currentX: number };
type KeyMenu = { x: number; y: number; row: TrackRow; ids: string[] };
const EASINGS: DirectorMotionEasing[] = ['linear', 'smooth', 'hold'];

const FRAME_RATE = 24;
const LABEL_WIDTH = 184;
const LANE_PADDING = 20;
const MIN_HEIGHT = 168;
const MAX_ZOOM = 16;
const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2];
const actionLabels = new Map(PERSON_ACTIONS.map((action) => [action.id, action.labelKey]));
const poseLabels = new Map(PERSON_POSES.map((pose) => [pose.id, pose.labelKey]));

function clampTime(time: number, duration: number): number {
  return Math.min(duration, Math.max(0, time));
}

function formatTimecode(time: number): string {
  const seconds = Math.floor(time);
  const frames = Math.min(FRAME_RATE - 1, Math.round((time - seconds) * FRAME_RATE));
  return `${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

const DirectorPlaybackButton = memo(function DirectorPlaybackButton({ playbackSource, onToggle }: {
  playbackSource: Props['playbackSource'];
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isPlaying = useSyncExternalStore(playbackSource.subscribe, playbackSource.getSnapshot, playbackSource.getSnapshot);
  const help = t(`directorStudio.previs.timeline.${isPlaying ? 'pauseHelp' : 'playHelp'}`);
  return (
    <button
      type="button"
      onClick={onToggle}
      data-director-tooltip={help}
      data-director-tooltip-keys="Space"
      aria-label={t(`directorStudio.motion.timeline.${isPlaying ? 'pause' : 'play'}`)}
      aria-pressed={isPlaying}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--accent-fg)] transition-[transform,box-shadow,background-color] hover:scale-105 active:scale-95 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--surface-rgb))] ${isPlaying ? 'bg-accent shadow-[0_0_0_4px_rgb(var(--accent-rgb)/0.2),0_4px_14px_rgb(var(--accent-rgb)/0.45)]' : 'bg-accent shadow-[0_4px_12px_rgb(var(--accent-rgb)/0.35)]'}`}
    >
      {isPlaying ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />}
    </button>
  );
});

/** Ghost icon button for the timeline toolbar; tooltip text doubles as the accessible name. */
function BarButton({ label, keys, active, disabled, onClick, children }: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      data-director-tooltip={label}
      data-director-tooltip-keys={keys}
      className={`grid h-7 min-w-7 shrink-0 place-items-center rounded-md px-1.5 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-35 ${active ? 'bg-[rgb(var(--accent-rgb)/0.18)] text-accent' : 'text-text-muted hover:bg-[var(--hover)] hover:text-text-dark'}`}
    >
      {children}
    </button>
  );
}

/** Right-click menu for one or several keyframes of a row: easing, look-at (camera), duplicate, delete. */
function KeyframeMenu({ menu, items, onClose, onEasing, onLookAt, onDuplicate, onDelete }: {
  menu: KeyMenu;
  items: BlueprintItem[];
  onClose: () => void;
  onEasing: (easing: DirectorMotionEasing) => void;
  onLookAt: (targetId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // Keep the menu inside the window; flip above the pointer near the bottom edge.
    setPosition({
      left: Math.min(menu.x, window.innerWidth - box.width - 8),
      top: menu.y + box.height + 8 > window.innerHeight ? Math.max(8, menu.y - box.height) : menu.y,
    });
  }, [menu.x, menu.y]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!(event.target instanceof Node && ref.current?.contains(event.target))) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const frames = menu.row.keyframes.filter((frame) => menu.ids.includes(frame.id));
  const currentEasing = frames.every((frame) => frame.easing === frames[0]?.easing) ? frames[0]?.easing : undefined;
  const itemClass = 'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-text-muted transition-colors hover:bg-[var(--hover)] hover:text-text-dark';
  return (
    <div ref={ref} role="menu" data-stage-popover className="stage-glass stage-pop fixed z-[80] w-52 rounded-xl p-1" style={position}>
      <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
        {menu.ids.length > 1 ? t('directorStudio.previs.timeline.multiCount', { count: menu.ids.length }) : t('directorStudio.motion.inspector.easing')}
      </div>
      {EASINGS.map((easing) => (
        <button key={easing} type="button" role="menuitemradio" aria-checked={currentEasing === easing} className={itemClass} onClick={() => onEasing(easing)}>
          <span className={`h-2 w-2 rounded-full ${currentEasing === easing ? 'bg-accent' : 'bg-[var(--line-strong)]'}`} />
          <span className="flex-1">{t(`directorStudio.motion.inspector.${easing}`)}</span>
        </button>
      ))}
      {menu.row.kind === 'camera' && items.length ? (
        <>
          <div className="my-1 h-px bg-[var(--line)]" />
          <div className="px-2.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-subtle">{t('directorStudio.previs.timeline.multiLookAt')}</div>
          <div className="ui-scrollbar max-h-40 overflow-y-auto">
            {items.map((item) => (
              <button key={item.id} type="button" role="menuitem" className={itemClass} onClick={() => onLookAt(item.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color || '#9ca3af' }} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {frames.every((frame) => frame.trackTargetId === item.id) ? <span className="text-[10px] text-accent">●</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="my-1 h-px bg-[var(--line)]" />
      {menu.ids.length === 1 ? (
        <button type="button" role="menuitem" className={itemClass} onClick={onDuplicate}><Copy className="h-3.5 w-3.5" /><span className="flex-1">{t('directorStudio.motion.inspector.duplicate')}</span><kbd className="stage-kbd">⌘ drag</kbd></button>
      ) : null}
      <button type="button" role="menuitem" className={`${itemClass} text-danger hover:text-danger`} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /><span className="flex-1">{t('directorStudio.motion.inspector.delete')}</span><kbd className="stage-kbd">Delete</kbd></button>
    </div>
  );
}

export const DirectorTimeline = memo(function DirectorTimeline({
  height, maxHeight, onHeightChange, project, items, selectedItemId, timeSource, playbackSource, playbackRate, onPlaybackRateChange, selection,
  onTimeChange, onTogglePlayback, onGoToStart, onLoopChange, onDurationChange, onSelectionChange,
  onSelectItem, onSelectCamera, onMoveKeyframe, onCopyKeyframe, onPatchKeyframes, onDeleteKeyframes, onRetimeTrack, onAddCameraKeyframe, onAddObjectKeyframe, onAddActionKeyframe,
  onSplitAtTime, onCopyTrack, rigActions,
}: Props) {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizeStartRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  const [zoom, setZoom] = useState(1);
  // Scroll target for the next zoom render; applied once the wider lane is laid out.
  const pendingScrollRef = useRef<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [activeRowKey, setActiveRowKey] = useState('camera');
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const setDrag = useCallback((next: DragState | null) => {
    // Keep pointerup synchronous with the latest pointermove, before React renders.
    dragStateRef.current = next;
    setDragState(next);
  }, []);
  const isDragging = dragState !== null;
  const [multi, setMulti] = useState<MultiSelection | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [keyMenu, setKeyMenu] = useState<KeyMenu | null>(null);
  const baseLaneWidth = Math.max(280, viewportWidth - LABEL_WIDTH - LANE_PADDING);
  const laneWidth = baseLaneWidth * zoom;
  const duration = project.durationSeconds;
  const minimumHeight = Math.min(MIN_HEIGHT, maxHeight);
  const clampHeight = (next: number) => Math.max(minimumHeight, Math.min(maxHeight, next));

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const measure = () => setViewportWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo<TrackRow[]>(() => {
    const result: TrackRow[] = [{ key: 'camera', kind: 'camera', trackId: 'camera', label: t('directorStudio.motion.timeline.camera'), keyframes: project.cameraTrack, onAdd: onAddCameraKeyframe }];
    items.forEach((item) => {
      result.push({ key: `object:${item.id}`, kind: 'object', trackId: item.id, label: item.label, keyframes: project.objectTracks[item.id] ?? [], onAdd: () => onAddObjectKeyframe(item.id) });
      // Keep authored actions visible; show an empty action lane only for the selected person.
      const actions = project.actionTracks[item.id] ?? [];
      if (item.category === 'person' && (actions.length > 0 || selectedItemId === item.id || (selection?.kind === 'action' && selection.trackId === item.id))) {
        result.push({ key: `action:${item.id}`, kind: 'action', trackId: item.id, label: t('directorStudio.motion.timeline.actionTrack', { name: item.label }), keyframes: actions, onAdd: () => onAddActionKeyframe(item.id) });
      }
    });
    return result;
  }, [items, onAddActionKeyframe, onAddCameraKeyframe, onAddObjectKeyframe, project.actionTracks, project.cameraTrack, project.objectTracks, selectedItemId, selection, t]);

  const activeRow = rows.find((row) => row.key === activeRowKey);
  const selectedRowKey = selection
    ? selection.kind === 'camera' ? 'camera' : `${selection.kind}:${selection.trackId}`
    : selectedItemId
      ? activeRow?.trackId === selectedItemId ? activeRowKey : `object:${selectedItemId}`
      : 'camera';
  const snapTime = useCallback((time: number, bypass = false) => {
    if (!snapEnabled || bypass) return clampTime(time, duration);
    const moving = dragStateRef.current;
    const boundaries = rows.flatMap((row) => row.keyframes.filter((frame) => !moving || (moving.mode === 'keyframe'
      ? frame.id !== moving.selection.keyframeId : row.trackId !== moving.selection.trackId || row.kind !== moving.selection.kind)).map((frame) => frame.time));
    return snapStageTimelineTime(time, duration, laneWidth, boundaries, timeSource.getSnapshot());
  }, [duration, snapEnabled, rows, laneWidth, timeSource]);
  const timeFromPointer = useCallback((clientX: number, rect: DOMRect, bypass = false) => snapTime((clientX - rect.left) / Math.max(1, rect.width) * duration, bypass), [duration, snapTime]);
  /** Focus a row; a keyframe is selected only when one was explicitly targeted. */
  const selectRow = useCallback((row: TrackRow, frame: TrackFrame | null) => {
    setActiveRowKey(row.key);
    if (row.kind === 'camera') onSelectCamera?.();
    else onSelectItem(row.trackId);
    onSelectionChange(frame ? { kind: row.kind, trackId: row.trackId, keyframeId: frame.id } : null);
  }, [onSelectCamera, onSelectItem, onSelectionChange]);

  /** Keyframe ids the next batch action applies to: the multi-selection, else the single selection in `row`. */
  const targetIds = useCallback((row: TrackRow): string[] => {
    if (multi?.rowKey === row.key && multi.ids.length) return multi.ids;
    return selection && selection.kind === row.kind && selection.trackId === row.trackId ? [selection.keyframeId] : [];
  }, [multi, selection]);

  const toggleMultiFrame = (row: TrackRow, frame: TrackFrame) => {
    const base = multi?.rowKey === row.key
      ? multi.ids
      : selection && selection.kind === row.kind && selection.trackId === row.trackId ? [selection.keyframeId] : [];
    const ids = base.includes(frame.id) ? base.filter((id) => id !== frame.id) : [...base, frame.id];
    setMulti(ids.length > 1 ? { rowKey: row.key, ids } : null);
    const primary = ids.length ? row.keyframes.find((entry) => entry.id === ids[ids.length - 1]) ?? null : null;
    selectRow(row, primary);
  };

  // Drop multi-selections whose keyframes disappeared (deleted, track replaced).
  useEffect(() => {
    if (!multi) return;
    const row = rows.find((entry) => entry.key === multi.rowKey);
    const alive = row ? multi.ids.filter((id) => row.keyframes.some((frame) => frame.id === id)) : [];
    if (alive.length !== multi.ids.length) setMulti(alive.length > 1 ? { rowKey: multi.rowKey, ids: alive } : null);
  }, [multi, rows]);

  useLayoutEffect(() => {
    // Register before the first gesture, independently of drag-state rendering.
    // A fast down/up sequence must work even when no move event was delivered.
    const samplePointer = (active: DragState, event: PointerEvent): DragState => {
      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - active.scrollLeft;
      const distance = event.clientX - active.pointerStartX + scrollDelta;
      if (Math.abs(distance) < 3) {
        return active.mode === 'keyframe'
          ? { ...active, time: active.initialTime }
          : { ...active, nextStart: active.start, nextEnd: active.end };
      }
      const delta = distance / Math.max(1, active.rect.width) * duration;
      if (active.mode === 'keyframe') {
        return { ...active, time: snapTime(active.initialTime + delta, event.altKey) };
      }
      const span = active.end - active.start;
      if (active.handle === 'move') {
        const nextStart = Math.min(duration - span, snapTime(active.start + delta, event.altKey));
        return { ...active, nextStart, nextEnd: nextStart + span };
      }
      if (active.handle === 'start') {
        return { ...active, nextStart: Math.max(0, Math.min(active.end - 0.2, snapTime(active.start + delta, event.altKey))), nextEnd: active.end };
      }
      return { ...active, nextStart: active.start, nextEnd: Math.min(duration, Math.max(active.start + 0.2, snapTime(active.end + delta, event.altKey))) };
    };
    const handleMove = (event: PointerEvent) => {
      const active = dragStateRef.current;
      if (active?.pointerId === event.pointerId) setDrag(samplePointer(active, event));
    };
    const handleUp = (event: PointerEvent) => {
      const active = dragStateRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const final = samplePointer(active, event);
      // Clear before callbacks to prevent duplicate commits or a late cancel.
      setDrag(null);
      if (final.mode === 'keyframe' && Math.abs(final.time - final.initialTime) > 0.0001) {
        if (final.copy) onCopyKeyframe(final.selection, final.time);
        else onMoveKeyframe(final.selection, final.time);
        onTimeChange(final.time);
      } else if (final.mode === 'track' && (Math.abs(final.nextStart - final.start) > 0.0001 || Math.abs(final.nextEnd - final.end) > 0.0001)) {
        if (final.copy && onCopyTrack) onCopyTrack(final.kind, final.selection.trackId, final.nextStart, final.nextEnd);
        else onRetimeTrack(final.kind, final.selection.trackId, final.nextStart, final.nextEnd);
        onTimeChange(final.nextStart);
      }
    };
    const cancel = () => { if (dragStateRef.current) setDrag(null); };
    const handleCancel = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId === event.pointerId) cancel();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragStateRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [duration, onCopyKeyframe, onMoveKeyframe, onRetimeTrack, onCopyTrack, onTimeChange, setDrag, snapTime]);

  const beginKeyframeDrag = (event: React.PointerEvent<HTMLElement>, row: TrackRow, frame: TrackFrame) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (event.shiftKey) {
      toggleMultiFrame(row, frame);
      return;
    }
    const lane = event.currentTarget.closest('[data-timeline-lane]');
    if (!(lane instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMulti(null);
    selectRow(row, frame);
    onTimeChange(frame.time);
    // ⌘/Ctrl-drag leaves the original in place and drops a copy (Alt still bypasses snapping).
    setDrag({ mode: 'keyframe', copy: event.metaKey || event.ctrlKey, selection: { kind: row.kind, trackId: row.trackId, keyframeId: frame.id }, rect: lane.getBoundingClientRect(), pointerId: event.pointerId, pointerStartX: event.clientX, scrollLeft: scrollRef.current?.scrollLeft ?? 0, initialTime: frame.time, time: frame.time });
  };

  /** Shift-drag on an empty lane rubber-bands the keyframes of that row. */
  const beginMarquee = (event: React.PointerEvent<HTMLElement>, row: TrackRow) => {
    const lane = event.currentTarget;
    lane.setPointerCapture(event.pointerId);
    setMarquee({ rowKey: row.key, pointerId: event.pointerId, rect: lane.getBoundingClientRect(), startX: event.clientX, currentX: event.clientX });
  };
  const finishMarquee = (row: TrackRow, active: Marquee) => {
    setMarquee(null);
    const [from, to] = [active.startX, active.currentX].sort((a, b) => a - b).map((x) => (x - active.rect.left) / Math.max(1, active.rect.width) * duration);
    const ids = row.keyframes.filter((frame) => frame.time >= from - 0.0001 && frame.time <= to + 0.0001).map((frame) => frame.id);
    setMulti(ids.length > 1 ? { rowKey: row.key, ids } : null);
    const primary = ids.length ? row.keyframes.find((frame) => frame.id === ids[0]) ?? null : null;
    selectRow(row, primary);
    if (primary) onTimeChange(primary.time);
  };

  const openKeyMenu = (event: React.MouseEvent<HTMLElement>, row: TrackRow, frame: TrackFrame) => {
    event.preventDefault();
    event.stopPropagation();
    const inMulti = multi?.rowKey === row.key && multi.ids.includes(frame.id);
    if (!inMulti) {
      setMulti(null);
      selectRow(row, frame);
    }
    setKeyMenu({ x: event.clientX, y: event.clientY, row, ids: inMulti && multi ? multi.ids : [frame.id] });
  };

  const beginTrackDrag = (event: React.PointerEvent<HTMLElement>, row: TrackRow, handle: 'move' | 'start' | 'end') => {
    event.stopPropagation();
    if (event.button !== 0 || row.kind === 'action' || row.keyframes.length < 2) return;
    const lane = event.currentTarget.closest('[data-timeline-lane]');
    if (!(lane instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const first = row.keyframes[0];
    const end = row.keyframes[row.keyframes.length - 1].time;
    selectRow(row, null);
    onTimeChange(first.time);
    setDrag({ mode: 'track', copy: handle === 'move' && (event.metaKey || event.ctrlKey), kind: row.kind, selection: { kind: row.kind, trackId: row.trackId, keyframeId: first.id }, rect: lane.getBoundingClientRect(), pointerId: event.pointerId, pointerStartX: event.clientX, scrollLeft: scrollRef.current?.scrollLeft ?? 0, start: first.time, end, nextStart: first.time, nextEnd: end, handle });
  };

  const moveFrameWithKeyboard = (event: React.KeyboardEvent<HTMLElement>, row: TrackRow, frame: TrackFrame) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const time = clampTime(frame.time + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / FRAME_RATE, duration);
    selectRow(row, frame);
    onMoveKeyframe({ kind: row.kind, trackId: row.trackId, keyframeId: frame.id }, time);
    onTimeChange(time);
  };

  const moveTrackWithKeyboard = (event: React.KeyboardEvent<HTMLElement>, row: TrackRow, handle: 'move' | 'start' | 'end') => {
    if (row.kind === 'action' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    event.stopPropagation();
    const start = row.keyframes[0].time;
    const end = row.keyframes[row.keyframes.length - 1].time;
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / FRAME_RATE;
    const nextStart = handle === 'end' ? start : Math.max(0, Math.min(handle === 'move' ? duration - (end - start) : end - 0.2, start + delta));
    const nextEnd = handle === 'move' ? nextStart + end - start : handle === 'start' ? end : Math.min(duration, Math.max(start + 0.2, end + delta));
    selectRow(row, null);
    onRetimeTrack(row.kind, row.trackId, nextStart, nextEnd);
    onTimeChange(nextStart);
  };

  useEffect(() => {
    const syncPlaybackTime = () => {
      const time = clampTime(timeSource.getSnapshot(), duration);
      timelineRef.current?.style.setProperty('--director-motion-playhead', `${time / duration * 100}%`);
      if (timecodeRef.current) timecodeRef.current.textContent = formatTimecode(time);
    };
    syncPlaybackTime();
    return timeSource.subscribe(syncPlaybackTime);
  }, [duration, timeSource]);

  /** Zoom keeping the time under `anchorX` (px from the lane's visible left edge) fixed. */
  const zoomAround = useCallback((nextValue: number, anchorX?: number) => {
    const nextZoom = Math.min(MAX_ZOOM, Math.max(1, nextValue));
    const scroller = scrollRef.current;
    if (!scroller || nextZoom === zoom) {
      setZoom(nextZoom);
      return;
    }
    const visibleLane = Math.max(1, scroller.clientWidth - LABEL_WIDTH - LANE_PADDING);
    const anchor = anchorX ?? visibleLane / 2;
    const ratio = (scroller.scrollLeft + anchor) / (baseLaneWidth * zoom);
    pendingScrollRef.current = Math.max(0, ratio * baseLaneWidth * nextZoom - anchor);
    setZoom(nextZoom);
  }, [baseLaneWidth, zoom]);

  useLayoutEffect(() => {
    const target = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (target !== null && scrollRef.current) scrollRef.current.scrollLeft = target;
  }, [zoom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    // Native listener: React wheel handlers are passive and cannot prevent page zoom.
    const handleWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || dragStateRef.current) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const anchor = Math.max(0, event.clientX - rect.left - LABEL_WIDTH);
      zoomAround(zoom * Math.exp(-event.deltaY * 0.0035), anchor);
    };
    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [zoom, zoomAround]);

  const zoomToTrackKeyframes = (row: TrackRow) => {
    if (row.keyframes.length === 0) return;
    const sortedTimes = row.keyframes.map((frame) => frame.time).sort((a, b) => a - b);
    const positiveGaps = sortedTimes.slice(1).map((time, index) => time - sortedTimes[index]).filter((gap) => gap > 0);
    const minimumGap = positiveGaps.length > 0 ? Math.min(...positiveGaps) : duration;
    const requiredZoom = duration * 28 / (minimumGap * baseLaneWidth);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(1, 2 ** Math.ceil(Math.log2(requiredZoom))));
    selectRow(row, null);
    const target = Math.max(0, sortedTimes[0] / duration * baseLaneWidth * nextZoom - 24);
    if (nextZoom === zoom) {
      if (scrollRef.current) scrollRef.current.scrollLeft = target;
      return;
    }
    pendingScrollRef.current = target;
    setZoom(nextZoom);
  };
  const tickInterval = [1 / FRAME_RATE, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((step) => step / duration * laneWidth >= 64) ?? 60;
  const tickTimes = Array.from({ length: Math.floor(duration / tickInterval) + 1 }, (_, index) => index * tickInterval).filter((time) => duration - time > tickInterval * 0.35);
  tickTimes.push(duration);
  const tip = (key: string) => t(`directorStudio.previs.timeline.${key}`);
  const dragBadge = dragState
    ? dragState.mode === 'keyframe'
      ? { left: dragState.time / duration * 100, text: dragState.copy ? `+ ${dragState.time.toFixed(2)}s` : `${dragState.time.toFixed(2)}s` }
      : { left: (dragState.handle === 'end' ? dragState.nextEnd : dragState.nextStart) / duration * 100, text: `${dragState.nextStart.toFixed(2)} – ${dragState.nextEnd.toFixed(2)}s` }
    : null;
  const activeRowForKeys = rows.find((row) => row.key === selectedRowKey) ?? rows[0];
  const multiRow = multi ? rows.find((row) => row.key === multi.rowKey) ?? null : null;
  const lookTargets = items.filter((item) => item.category !== 'scene');
  const applyLookAt = (row: TrackRow, ids: string[], targetId: string) => {
    onPatchKeyframes(row, ids, { trackTargetId: targetId, freeRotation: undefined });
  };
  const deleteTargets = (row: TrackRow, ids: string[]) => {
    if (!ids.length) return;
    onDeleteKeyframes(row, ids);
    setMulti(null);
  };

  return (
    <section ref={timelineRef} tabIndex={-1} data-stage-timeline className="ui-director-timeline-enter relative z-10 flex shrink-0 flex-col border-t border-[var(--line-strong)] bg-surface text-text-dark outline-hidden" style={{ height }} aria-label={t('directorStudio.motion.timeline.title')}
      onKeyDown={(event) => {
        event.stopPropagation();
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, select, [aria-haspopup="listbox"], [contenteditable="true"]')) return;
        const current = timeSource.getSnapshot();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (dragStateRef.current) setDrag(null);
          else if (keyMenu) setKeyMenu(null);
          else if (multi) setMulti(null);
          return;
        }
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
        if (plain && event.key.toLowerCase() === 's' && activeRowForKeys && onSplitAtTime) {
          event.preventDefault(); onSplitAtTime(activeRowForKeys.kind, activeRowForKeys.trackId, current); return;
        }
        if (plain && (event.key === 'k' || event.key === 'K' || event.key === 'i' || event.key === 'I')) {
          // K (I compatible): key the focused track at the playhead.
          event.preventDefault();
          if (activeRowForKeys) { selectRow(activeRowForKeys, null); activeRowForKeys.onAdd(); }
          return;
        }
        if (plain && (event.key === 'Delete' || event.key === 'Backspace')) {
          const row = multiRow ?? (selection ? rows.find((entry) => entry.kind === selection.kind && entry.trackId === selection.trackId) ?? null : null);
          if (row) { event.preventDefault(); deleteTargets(row, targetIds(row)); }
          return;
        }
        if (event.key === ' ' && !(target instanceof HTMLElement && target.closest('button'))) { event.preventDefault(); onTogglePlayback(); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onTimeChange(clampTime(current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / FRAME_RATE, duration)); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const times = [...new Set(rows.flatMap((row) => row.keyframes.map((frame) => frame.time)))].sort((a, b) => a - b);
          const next = event.key === 'ArrowUp' ? [...times].reverse().find((time) => time < current - 0.001) : times.find((time) => time > current + 0.001);
          if (next !== undefined) onTimeChange(next);
        } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); onTimeChange(event.key === 'Home' ? 0 : duration); }
      }} onKeyUp={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <div role="separator" aria-orientation="horizontal" aria-label={t('directorStudio.motion.timeline.resize')} aria-valuemin={minimumHeight} aria-valuemax={maxHeight} aria-valuenow={height} tabIndex={0}
        data-director-tooltip={t('directorStudio.motion.timeline.resize')}
        className="group absolute inset-x-0 -top-1 z-30 flex h-2 cursor-ns-resize touch-none items-center justify-center outline-hidden"
        onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizeStartRef.current = { pointerId: event.pointerId, y: event.clientY, height }; }}
        onPointerMove={(event) => { const start = resizeStartRef.current; if (start?.pointerId === event.pointerId) timelineRef.current?.style.setProperty('height', `${clampHeight(start.height + start.y - event.clientY)}px`); }}
        onPointerUp={(event) => { const start = resizeStartRef.current; if (!start || start.pointerId !== event.pointerId) return; resizeStartRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); onHeightChange(clampHeight(start.height + start.y - event.clientY)); }}
        onPointerCancel={() => { resizeStartRef.current = null; timelineRef.current?.style.setProperty('height', `${height}px`); }}
        onKeyDown={(event) => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); event.stopPropagation(); onHeightChange(clampHeight(height + (event.key === 'ArrowUp' ? 20 : -20))); }}>
        <span className="h-[3px] w-12 rounded-full bg-[var(--line-strong)] transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>

      <div className="ui-scrollbar flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--line)] px-3">
        <BarButton label={tip('startHelp')} keys="Home" onClick={onGoToStart}><SkipBack className="h-3.5 w-3.5" /></BarButton>
        <DirectorPlaybackButton playbackSource={playbackSource} onToggle={onTogglePlayback} />
        <BarButton label={tip('loopHelp')} active={project.loop} onClick={() => onLoopChange(!project.loop)}><Repeat2 className="h-3.5 w-3.5" /></BarButton>
        <div className="ml-1.5 flex h-8 shrink-0 items-baseline gap-1 rounded-lg bg-black/25 px-2.5 pt-[7px] font-mono tabular-nums shadow-[inset_0_0_0_1px_var(--line)]" aria-live="off" data-director-tooltip={t('directorStudio.motion.timeline.currentTime')}>
          <span ref={timecodeRef} className="text-[13px] font-semibold text-text-dark">00:00</span>
          <span className="text-[10px] text-text-subtle">/ {formatTimecode(duration)}</span>
        </div>
        <ScrubNumber
          label={t('directorStudio.previs.timeline.durationShort')}
          ariaLabel={t('directorStudio.motion.timeline.duration')}
          value={duration}
          min={DIRECTOR_MOTION_MIN_DURATION_SECONDS}
          max={DIRECTOR_MOTION_MAX_DURATION_SECONDS}
          step={0.5}
          suffix="s"
          className="w-[96px] shrink-0"
          onCommit={(value) => { if (value !== duration) onDurationChange(value); }}
        />
        <div className="flex h-7 shrink-0 items-center rounded-md bg-[var(--hover)] p-0.5" role="radiogroup" aria-label={t('directorStudio.previs.timeline.speed')} data-director-tooltip={tip('speedHelp')}>
          {PLAYBACK_RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              role="radio"
              aria-checked={playbackRate === rate}
              onClick={() => onPlaybackRateChange(rate)}
              className={`h-6 rounded-[5px] px-1.5 font-mono text-[10.5px] transition-colors ${playbackRate === rate ? 'bg-[rgb(var(--raised-rgb))] text-text-dark shadow-[0_1px_2px_rgb(0_0_0/0.4)]' : 'text-text-subtle hover:text-text-muted'}`}
            >
              {rate}×
            </button>
          ))}
        </div>
        {multi && multiRow ? (
          <div className="stage-pop ml-2 flex h-8 shrink-0 items-center gap-1 rounded-lg bg-[rgb(var(--accent-rgb)/0.14)] pl-2.5 pr-1 shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.35)]" role="group" aria-label={tip('multiLabel')}>
            <span className="text-[11px] font-semibold text-text-dark">{t('directorStudio.previs.timeline.multiCount', { count: multi.ids.length })}</span>
            {multiRow.kind === 'camera' && lookTargets.length ? (
              <select
                value=""
                onChange={(event) => { if (event.target.value) applyLookAt(multiRow, multi.ids, event.target.value); }}
                className="h-6 max-w-[140px] rounded-md border-0 bg-[var(--hover)] px-1.5 text-[11px] text-text-dark outline-hidden"
                aria-label={tip('multiLookAt')}
                data-director-tooltip={tip('multiLookAtHelp')}
              >
                <option value="">{tip('multiLookAt')}</option>
                {lookTargets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            ) : null}
            <select
              value=""
              onChange={(event) => { const easing = EASINGS.find((entry) => entry === event.target.value); if (easing) onPatchKeyframes(multiRow, multi.ids, { easing }); }}
              className="h-6 rounded-md border-0 bg-[var(--hover)] px-1.5 text-[11px] text-text-dark outline-hidden"
              aria-label={t('directorStudio.motion.inspector.easing')}
            >
              <option value="">{t('directorStudio.motion.inspector.easing')}</option>
              {EASINGS.map((easing) => <option key={easing} value={easing}>{t(`directorStudio.motion.inspector.${easing}`)}</option>)}
            </select>
            <BarButton label={t('directorStudio.motion.inspector.delete')} keys="Delete" onClick={() => deleteTargets(multiRow, multi.ids)}><Trash2 className="h-3.5 w-3.5" /></BarButton>
            <BarButton label={tip('multiClear')} keys="Esc" onClick={() => setMulti(null)}><X className="h-3.5 w-3.5" /></BarButton>
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3">
          <BarButton label={tip('snapHelp')} active={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}><Magnet className="h-3.5 w-3.5" /></BarButton>
          <span className="mx-1.5 h-4 w-px bg-[var(--line-strong)]" />
          <BarButton label={tip('zoomOutHelp')} disabled={zoom <= 1 || isDragging} onClick={() => zoomAround(zoom / 2)}><Minus className="h-3.5 w-3.5" /></BarButton>
          <button type="button" onClick={() => zoomAround(1)} disabled={isDragging || zoom === 1} data-director-tooltip={tip('fitHelp')} className="h-7 min-w-11 rounded-md font-mono text-[11px] text-text-muted transition-colors hover:bg-[var(--hover)] hover:text-text-dark disabled:hover:bg-transparent" aria-live="polite">{Math.round(zoom * 100)}%</button>
          <BarButton label={tip('zoomInHelp')} disabled={zoom >= MAX_ZOOM || isDragging} onClick={() => zoomAround(zoom * 2)}><Plus className="h-3.5 w-3.5" /></BarButton>
        </div>
      </div>

      <div ref={scrollRef} className="ui-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="relative" style={{ width: LABEL_WIDTH + laneWidth + LANE_PADDING, minWidth: '100%' }}>
          <div className="sticky top-0 z-20 flex h-7 border-b border-[var(--line)] bg-surface">
            <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-[var(--line)] bg-surface px-3 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-subtle" style={{ width: LABEL_WIDTH }}>{t('directorStudio.motion.timeline.tracks')}</div>
            <div tabIndex={0} role="group" className="relative shrink-0 cursor-col-resize touch-none outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70" style={{ width: laneWidth }} data-director-tooltip={t('directorStudio.motion.timeline.scrubHelp')} aria-label={t('directorStudio.motion.timeline.scrubHelp')}
              onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey)); }}
              onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey)); }}
              onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
              {tickTimes.map((time, index) => <span key={index} className="pointer-events-none absolute bottom-0 h-2 border-l border-[var(--line-strong)]" style={{ left: `${time / duration * 100}%` }}><span className={`absolute -top-[15px] font-mono text-[10px] text-text-subtle ${time === duration ? 'right-1' : 'left-1'}`}>{`${Number(time.toFixed(2))}s`}</span></span>)}
              <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent" style={{ left: 'var(--director-motion-playhead, 0%)' }}>
                <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-accent" />
              </span>
              {dragBadge ? (
                <span className="pointer-events-none absolute top-[3px] z-20 -translate-x-1/2 rounded-md bg-accent px-1.5 py-px font-mono text-[10px] font-semibold text-[var(--accent-fg)] shadow-[0_4px_12px_rgb(var(--accent-rgb)/0.45)]" style={{ left: `${dragBadge.left}%` }}>{dragBadge.text}</span>
              ) : null}
            </div>
          </div>
          {rigActions ? <StageRigTimeline rigs={project.cameraRigs} duration={duration} laneWidth={laneWidth} labelWidth={LABEL_WIDTH} playhead={timeSource.getSnapshot} actions={rigActions} /> : null}
          {rows.map((row) => {
            const activeDrag = dragState?.selection.kind === row.kind && dragState.selection.trackId === row.trackId ? dragState : null;
            const displayedFrames = activeDrag?.mode === 'track'
              ? retimeDirectorTrack(row.keyframes, activeDrag.nextStart, activeDrag.nextEnd, duration)
              : activeDrag?.mode === 'keyframe'
                ? activeDrag.copy
                  ? row.keyframes
                  : row.keyframes.map((frame) => frame.id === activeDrag.selection.keyframeId ? { ...frame, time: activeDrag.time } : frame).sort((a, b) => a.time - b.time)
                : row.keyframes;
            const copyGhost = activeDrag?.mode === 'keyframe' && activeDrag.copy && Math.abs(activeDrag.time - activeDrag.initialTime) > 0.0001 ? activeDrag.time : null;
            const rowMarquee = marquee?.rowKey === row.key ? marquee : null;
            const hasRouteClip = row.kind !== 'action' && displayedFrames.length >= 2 && displayedFrames[displayedFrames.length - 1].time > displayedFrames[0].time;
            const clipStart = hasRouteClip ? displayedFrames[0].time : 0;
            const clipEnd = hasRouteClip ? displayedFrames[displayedFrames.length - 1].time : 0;
            const clipPixels = (clipEnd - clipStart) / duration * laneWidth;
            const selectedTrack = selectedRowKey === row.key;
            const unavailable = row.kind !== 'camera' && items.some((item) => item.id === row.trackId && (item.hidden || item.locked));
            const RowIcon = row.kind === 'camera' ? Camera : row.kind === 'action' ? Sparkles : UserRound;
            return (
              <div key={row.key} className={`group/row flex h-[52px] border-b border-[var(--line)] transition-colors ${selectedTrack ? 'bg-[rgb(var(--accent-rgb)/0.06)]' : 'hover:bg-white/[0.015]'}`} data-timeline-track={row.key}>
                <div className={`sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-[var(--line)] pr-1.5 ${row.kind === 'action' ? 'pl-5' : 'pl-2'} ${selectedTrack ? 'bg-[rgb(var(--surface-rgb))] shadow-[inset_2px_0_0_rgb(var(--accent-rgb))]' : 'bg-surface'}`} style={{ width: LABEL_WIDTH }}>
                  <button
                    type="button"
                    onClick={() => selectRow(row, null)}
                    disabled={unavailable}
                    aria-pressed={selectedTrack}
                    data-director-tooltip={t('directorStudio.previs.timeline.selectTrackHelp', { name: row.label })}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 ${selectedTrack ? 'text-text-dark' : 'text-text-muted'}`}
                  >
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${row.kind === 'camera' ? 'bg-[rgb(var(--accent-rgb)/0.16)] text-accent' : row.kind === 'action' ? 'bg-[rgb(var(--success-rgb)/0.14)] text-success' : 'bg-[var(--hover)] text-text-muted'}`}>
                      <RowIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{row.label}</span>
                      <span className="block truncate text-[10px] text-text-subtle">
                        {row.keyframes.length > 0 ? t('directorStudio.previs.timeline.keyframeCount', { count: row.keyframes.length }) : t(`directorStudio.previs.timeline.${row.kind === 'action' ? 'emptyAction' : 'emptyTrack'}`)}
                      </span>
                    </span>
                  </button>
                  {row.keyframes.length > 1 ? (
                    <button type="button" onClick={() => zoomToTrackKeyframes(row)} disabled={isDragging} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-[var(--hover)] hover:text-text-dark focus-visible:opacity-100 group-hover/row:opacity-100" data-director-tooltip={tip('keyframeCountHelp')} aria-label={t('directorStudio.previs.timeline.keyframeCountAria', { name: row.label, count: row.keyframes.length })}>
                      <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button type="button" disabled={unavailable} onClick={() => { selectRow(row, null); row.onAdd(); }} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle transition-colors hover:bg-[rgb(var(--accent-rgb)/0.16)] hover:text-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70" aria-label={`${row.label} · ${t('directorStudio.motion.timeline.addKeyframe')}`} data-director-tooltip={tip(row.kind === 'action' ? 'addActionHelp' : 'addKeyframeHelp')}>
                    <Diamond className="h-3 w-3" />
                  </button>
                </div>
                <div data-timeline-lane inert={unavailable} className={`relative shrink-0 cursor-crosshair touch-none ${unavailable ? 'opacity-40' : ''}`} style={{ width: laneWidth, backgroundImage: 'linear-gradient(to right, var(--line) 1px, transparent 1px)', backgroundSize: `${tickInterval / duration * laneWidth}px 100%` }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    // Lanes are not focusable; keep K / Delete / Esc routed to the timeline after a lane press.
                    timelineRef.current?.focus({ preventScroll: true });
                    if (event.shiftKey) { beginMarquee(event, row); return; }
                    setMulti(null);
                    selectRow(row, null);
                    onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey));
                  }}
                  onPointerMove={(event) => { if (rowMarquee && rowMarquee.pointerId === event.pointerId) setMarquee({ ...rowMarquee, currentX: event.clientX }); }}
                  onPointerUp={(event) => { if (rowMarquee && rowMarquee.pointerId === event.pointerId) finishMarquee(row, { ...rowMarquee, currentX: event.clientX }); }}
                  onPointerCancel={() => { if (rowMarquee) setMarquee(null); }}>
                  {rowMarquee ? (
                    <div
                      className="pointer-events-none absolute inset-y-1 z-[12] rounded-md bg-[rgb(var(--accent-rgb)/0.14)] shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.7)]"
                      style={{ left: Math.min(rowMarquee.startX, rowMarquee.currentX) - rowMarquee.rect.left, width: Math.abs(rowMarquee.currentX - rowMarquee.startX) }}
                    />
                  ) : null}
                  {hasRouteClip ? (
                    <div className={`absolute top-[7px] h-[20px] rounded-[5px] transition-shadow ${row.kind === 'camera' ? 'bg-[rgb(var(--accent-rgb)/0.3)]' : 'bg-[rgb(var(--accent-rgb)/0.22)]'} ${selectedTrack || activeDrag ? 'shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.9)]' : 'shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.4)]'}`} style={{ left: `${clipStart / duration * 100}%`, width: `${(clipEnd - clipStart) / duration * 100}%` }}>
                      <button type="button" onPointerDown={(event) => beginTrackDrag(event, row, 'move')} onClick={(event) => { if (event.detail === 0) selectRow(row, null); }} onKeyDown={(event) => moveTrackWithKeyboard(event, row, 'move')}
                        className="absolute inset-0 flex cursor-grab items-center overflow-hidden rounded-[5px] px-2.5 text-left text-[10.5px] font-medium text-text-dark transition-colors hover:bg-white/[0.06] active:cursor-grabbing focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                        data-director-tooltip={tip('routeHelp')} aria-label={t('directorStudio.motion.timeline.routeClipAria', { name: row.label, start: clipStart.toFixed(2), end: clipEnd.toFixed(2) })}>
                        {clipPixels >= 72 ? <span className="truncate">{t('directorStudio.motion.timeline.routeClip', { start: clipStart.toFixed(2), end: clipEnd.toFixed(2) })}</span> : null}
                      </button>
                      {clipPixels >= 28 ? (['start', 'end'] as const).map((handle) => (
                        <button key={handle} type="button" onPointerDown={(event) => beginTrackDrag(event, row, handle)} onClick={(event) => { if (event.detail === 0) selectRow(row, null); }} onKeyDown={(event) => moveTrackWithKeyboard(event, row, handle)}
                          className={`group/handle absolute inset-y-0 z-10 flex w-2 cursor-ew-resize items-center justify-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${handle === 'start' ? 'left-0 rounded-l-[5px]' : 'right-0 rounded-r-[5px]'}`}
                          data-director-tooltip={tip(handle === 'start' ? 'startHandleHelp' : 'endHelp')} aria-label={`${row.label} · ${t(`directorStudio.motion.timeline.${handle === 'start' ? 'trimStart' : 'trimEnd'}`)}`}>
                          <span className="h-2.5 w-[2px] rounded-full bg-white/45 transition-colors group-hover/handle:bg-white" />
                        </button>
                      )) : null}
                    </div>
                  ) : null}
                  {row.kind === 'action' ? displayedFrames.map((frame, index) => {
                    const end = displayedFrames[index + 1]?.time ?? duration;
                    const labelKey = frame.actionId ? actionLabels.get(frame.actionId) : frame.poseId ? poseLabels.get(frame.poseId) : undefined;
                    const actionLabel = frame.clipId ? project.customClips.find((clip) => clip.id === frame.clipId)?.name ?? t('directorStudio.motion.timeline.actionClip') : labelKey ? t(labelKey) : t('directorStudio.motion.timeline.actionClip');
                    const selected = selection?.kind === 'action' && selection.trackId === row.trackId && selection.keyframeId === frame.id;
                    return (
                      <button key={`action:${frame.id}`} type="button" onPointerDown={(event) => beginKeyframeDrag(event, row, frame)} onClick={(event) => { if (event.detail === 0) { selectRow(row, frame); onTimeChange(frame.time); } }} onKeyDown={(event) => moveFrameWithKeyboard(event, row, frame)}
                        className={`absolute top-[7px] h-[20px] cursor-grab truncate rounded-[5px] border-l-2 border-success bg-[rgb(var(--success-rgb)/0.18)] px-2 text-left text-[10.5px] font-medium text-success transition-[background-color,box-shadow] hover:bg-[rgb(var(--success-rgb)/0.26)] active:cursor-grabbing focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'shadow-[inset_0_0_0_1px_rgb(var(--success-rgb)/0.85)]' : ''}`}
                        style={{ left: `${frame.time / duration * 100}%`, width: `calc(${Math.max(0, end - frame.time) / duration * 100}% - 2px)` }}
                        data-director-tooltip={t('directorStudio.previs.timeline.actionHelp', { name: actionLabel })} aria-label={`${row.label} · ${actionLabel} · ${frame.time.toFixed(2)}s`} aria-pressed={selected}>
                        {actionLabel}
                      </button>
                    );
                  }) : null}
                  {displayedFrames.map((frame, index) => {
                    const selected = (selection?.kind === row.kind && selection.trackId === row.trackId && selection.keyframeId === frame.id)
                      || (multi?.rowKey === row.key && multi.ids.includes(frame.id));
                    const label = t('directorStudio.motion.timeline.keyframeAria', { name: row.label, index: index + 1, time: frame.time.toFixed(2) });
                    return (
                      <button key={frame.id} type="button" onPointerDown={(event) => beginKeyframeDrag(event, row, frame)} onClick={(event) => { if (event.detail === 0) { selectRow(row, frame); onTimeChange(frame.time); } }} onKeyDown={(event) => moveFrameWithKeyboard(event, row, frame)}
                        onContextMenu={(event) => openKeyMenu(event, row, frame)}
                        className={`stage-key top-[34px] ${selected ? 'z-[9]' : 'z-[5] hover:z-[11] focus-visible:z-[11]'}`}
                        data-selected={selected ? '' : undefined}
                        data-tone={row.kind === 'action' ? 'action' : undefined}
                        data-easing={frame.easing === 'hold' ? 'hold' : undefined}
                        style={{ left: `${frame.time / duration * 100}%` }}
                        data-director-tooltip={`${label} · ${tip('keyframeHelp')}`}
                        aria-label={label} aria-pressed={selected} />
                    );
                  })}
                  {copyGhost !== null ? <span className="stage-key pointer-events-none top-[34px] z-[12] opacity-60" data-selected="" style={{ left: `${copyGhost / duration * 100}%` }} /> : null}
                  <div className="pointer-events-none absolute inset-y-0 z-[6] w-px bg-accent/80" style={{ left: 'var(--director-motion-playhead, 0%)' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {keyMenu ? (
        <KeyframeMenu
          menu={keyMenu}
          items={lookTargets}
          onClose={() => setKeyMenu(null)}
          onEasing={(easing) => { onPatchKeyframes(keyMenu.row, keyMenu.ids, { easing }); setKeyMenu(null); }}
          onLookAt={(targetId) => { applyLookAt(keyMenu.row, keyMenu.ids, targetId); setKeyMenu(null); }}
          onDuplicate={() => {
            const frame = keyMenu.row.keyframes.find((entry) => entry.id === keyMenu.ids[0]);
            if (frame) onCopyKeyframe({ kind: keyMenu.row.kind, trackId: keyMenu.row.trackId, keyframeId: frame.id }, Math.min(duration, frame.time + 0.5));
            setKeyMenu(null);
          }}
          onDelete={() => { deleteTargets(keyMenu.row, keyMenu.ids); setKeyMenu(null); }}
        />
      ) : null}
    </section>
  );
});
