import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Camera, Magnet, Minus, Pause, Play, Plus, Repeat2, Rewind, Sparkles, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BlueprintItem, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import {
  DIRECTOR_PROCEDURAL_ACTIONS,
  DIRECTOR_STATIC_POSES,
  retimeDirectorTrack,
} from '@/features/canvas/application/directorMotion';
import type { DirectorKeyframeSelection } from './DirectorMotionInspector';

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
  onRetimeTrack: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onAddCameraKeyframe: () => void;
  onAddObjectKeyframe: (itemId: string) => void;
  onAddActionKeyframe: (itemId: string) => void;
};

type TrackRow = {
  key: string;
  kind: DirectorKeyframeSelection['kind'];
  trackId: string;
  label: string;
  keyframes: Array<{ id: string; time: number; actionId?: string | null; poseId?: string | null; clipId?: string | null }>;
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
  | { mode: 'keyframe'; initialTime: number; time: number }
  | {
      mode: 'track';
      kind: 'camera' | 'object';
      start: number;
      end: number;
      nextStart: number;
      nextEnd: number;
      handle: 'move' | 'start' | 'end';
    }
);

const FRAME_RATE = 24;
const LABEL_WIDTH = 176;
const MIN_HEIGHT = 180;
const buttonClass = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded px-2 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white active:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-30';
const inputClass = 'h-8 w-[64px] rounded border border-white/15 bg-black/20 px-1.5 text-right font-mono text-xs text-white/85 outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30';
const actionLabels = new Map(DIRECTOR_PROCEDURAL_ACTIONS.map((action) => [action.id, action.labelKey]));
const poseLabels = new Map(DIRECTOR_STATIC_POSES.map((pose) => [pose.id, pose.labelKey]));

function clampTime(time: number, duration: number): number {
  return Math.min(duration, Math.max(0, time));
}

const DirectorPlaybackButton = memo(function DirectorPlaybackButton({ playbackSource, onToggle }: {
  playbackSource: Props['playbackSource'];
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isPlaying = useSyncExternalStore(playbackSource.subscribe, playbackSource.getSnapshot, playbackSource.getSnapshot);
  const help = t(`directorStudio.previs.timeline.${isPlaying ? 'pauseHelp' : 'playHelp'}`);
  return (
    <button type="button" onClick={onToggle} className={`${buttonClass} w-9 bg-accent/20 text-accent hover:bg-accent/30 active:bg-accent/40`}
      title={help} data-director-tooltip={help}
      aria-label={t(`directorStudio.motion.timeline.${isPlaying ? 'pause' : 'play'}`)} aria-pressed={isPlaying}>
      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
    </button>
  );
});

export const DirectorTimeline = memo(function DirectorTimeline({
  height, maxHeight, onHeightChange, project, items, selectedItemId, timeSource, playbackSource, playbackRate, onPlaybackRateChange, selection,
  onTimeChange, onTogglePlayback, onGoToStart, onLoopChange, onDurationChange, onSelectionChange,
  onSelectItem, onSelectCamera, onMoveKeyframe, onRetimeTrack, onAddCameraKeyframe, onAddObjectKeyframe, onAddActionKeyframe,
}: Props) {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizeStartRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const currentTimeInputRef = useRef<HTMLInputElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  const [zoom, setZoom] = useState(1);
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
  const laneWidth = Math.max(280, viewportWidth - LABEL_WIDTH - 20) * zoom;
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
  const snapTime = useCallback((time: number, bypass = false) => clampTime(snapEnabled && !bypass ? Math.round(time * FRAME_RATE) / FRAME_RATE : time, duration), [duration, snapEnabled]);
  const timeFromPointer = useCallback((clientX: number, rect: DOMRect, bypass = false) => snapTime((clientX - rect.left) / Math.max(1, rect.width) * duration, bypass), [duration, snapTime]);
  const selectRow = useCallback((row: TrackRow, frame = row.keyframes[0]) => {
    setActiveRowKey(row.key);
    if (row.kind === 'camera') onSelectCamera?.();
    else onSelectItem(row.trackId);
    onSelectionChange(frame ? { kind: row.kind, trackId: row.trackId, keyframeId: frame.id } : null);
  }, [onSelectCamera, onSelectItem, onSelectionChange]);

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
        return { ...active, nextStart: Math.max(0, Math.min(active.end - 0.1, snapTime(active.start + delta, event.altKey))), nextEnd: active.end };
      }
      return { ...active, nextStart: active.start, nextEnd: Math.min(duration, Math.max(active.start + 0.1, snapTime(active.end + delta, event.altKey))) };
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
        onMoveKeyframe(final.selection, final.time);
        onTimeChange(final.time);
      } else if (final.mode === 'track' && (Math.abs(final.nextStart - final.start) > 0.0001 || Math.abs(final.nextEnd - final.end) > 0.0001)) {
        onRetimeTrack(final.kind, final.selection.trackId, final.nextStart, final.nextEnd);
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
  }, [duration, onMoveKeyframe, onRetimeTrack, onTimeChange, setDrag, snapTime]);

  const beginKeyframeDrag = (event: React.PointerEvent<HTMLButtonElement>, row: TrackRow, frame: TrackRow['keyframes'][number]) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const lane = event.currentTarget.closest('[data-timeline-lane]');
    if (!(lane instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectRow(row, frame);
    onTimeChange(frame.time);
    setDrag({ mode: 'keyframe', selection: { kind: row.kind, trackId: row.trackId, keyframeId: frame.id }, rect: lane.getBoundingClientRect(), pointerId: event.pointerId, pointerStartX: event.clientX, scrollLeft: scrollRef.current?.scrollLeft ?? 0, initialTime: frame.time, time: frame.time });
  };

  const beginTrackDrag = (event: React.PointerEvent<HTMLButtonElement>, row: TrackRow, handle: 'move' | 'start' | 'end') => {
    event.stopPropagation();
    if (event.button !== 0 || row.kind === 'action' || row.keyframes.length < 2) return;
    const lane = event.currentTarget.closest('[data-timeline-lane]');
    if (!(lane instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const first = row.keyframes[0];
    const end = row.keyframes[row.keyframes.length - 1].time;
    selectRow(row, first);
    onTimeChange(first.time);
    setDrag({ mode: 'track', kind: row.kind, selection: { kind: row.kind, trackId: row.trackId, keyframeId: first.id }, rect: lane.getBoundingClientRect(), pointerId: event.pointerId, pointerStartX: event.clientX, scrollLeft: scrollRef.current?.scrollLeft ?? 0, start: first.time, end, nextStart: first.time, nextEnd: end, handle });
  };

  const moveFrameWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, row: TrackRow, frame: TrackRow['keyframes'][number]) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const time = clampTime(frame.time + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / FRAME_RATE, duration);
    selectRow(row, frame);
    onMoveKeyframe({ kind: row.kind, trackId: row.trackId, keyframeId: frame.id }, time);
    onTimeChange(time);
  };

  const moveTrackWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, row: TrackRow, handle: 'move' | 'start' | 'end') => {
    if (row.kind === 'action' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    event.stopPropagation();
    const start = row.keyframes[0].time;
    const end = row.keyframes[row.keyframes.length - 1].time;
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / FRAME_RATE;
    const nextStart = handle === 'end' ? start : Math.max(0, Math.min(handle === 'move' ? duration - (end - start) : end - 0.1, start + delta));
    const nextEnd = handle === 'move' ? nextStart + end - start : handle === 'start' ? end : Math.min(duration, Math.max(start + 0.1, end + delta));
    selectRow(row);
    onRetimeTrack(row.kind, row.trackId, nextStart, nextEnd);
    onTimeChange(nextStart);
  };

  useEffect(() => {
    const syncPlaybackTime = () => {
      const time = clampTime(timeSource.getSnapshot(), duration);
      timelineRef.current?.style.setProperty('--director-motion-playhead', `${time / duration * 100}%`);
      if (currentTimeInputRef.current && document.activeElement !== currentTimeInputRef.current) currentTimeInputRef.current.value = time.toFixed(2);
    };
    syncPlaybackTime();
    return timeSource.subscribe(syncPlaybackTime);
  }, [duration, timeSource]);

  const changeZoom = (next: number) => {
    const nextZoom = Math.min(16, Math.max(1, next));
    const scroller = scrollRef.current;
    if (scroller) {
      // Keep the visible center at the same time when zooming in or out.
      const availableWidth = Math.max(1, scroller.clientWidth - LABEL_WIDTH - 20);
      const centerTimeRatio = (scroller.scrollLeft + availableWidth / 2) / laneWidth;
      setZoom(nextZoom);
      requestAnimationFrame(() => {
        scroller.scrollLeft = nextZoom === 1 ? 0 : Math.max(0, centerTimeRatio * (laneWidth / zoom * nextZoom) - availableWidth / 2);
      });
    } else setZoom(nextZoom);
  };
  const zoomToTrackKeyframes = (row: TrackRow) => {
    if (row.keyframes.length === 0) return;
    const sortedTimes = row.keyframes.map((frame) => frame.time).sort((a, b) => a - b);
    const positiveGaps = sortedTimes.slice(1).map((time, index) => time - sortedTimes[index]).filter((gap) => gap > 0);
    const minimumGap = positiveGaps.length > 0 ? Math.min(...positiveGaps) : duration;
    const baseWidth = laneWidth / zoom;
    const requiredZoom = duration * 28 / (minimumGap * baseWidth);
    const nextZoom = Math.min(16, Math.max(1, 2 ** Math.ceil(Math.log2(requiredZoom))));
    selectRow(row, row.keyframes.find((frame) => frame.id === selection?.keyframeId) ?? row.keyframes[0]);
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, sortedTimes[0] / duration * baseWidth * nextZoom - 24);
    });
  };
  const tickInterval = [1 / FRAME_RATE, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find((step) => step / duration * laneWidth >= 56) ?? 30;
  const tickTimes = Array.from({ length: Math.floor(duration / tickInterval) + 1 }, (_, index) => index * tickInterval).filter((time) => duration - time > tickInterval * 0.35);
  tickTimes.push(duration);
  const tooltip = (key: string) => ({ title: t(`directorStudio.previs.timeline.${key}`), 'data-director-tooltip': t(`directorStudio.previs.timeline.${key}`) });

  return (
    <section ref={timelineRef} className="ui-director-timeline-enter absolute inset-x-0 bottom-0 z-[64] flex flex-col border-t border-white/15 bg-[#171a1f] text-white shadow-[0_-8px_24px_rgba(0,0,0,0.16)]" style={{ height }} aria-label={t('directorStudio.motion.timeline.title')}
      onKeyDown={(event) => {
        event.stopPropagation();
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
        const current = timeSource.getSnapshot();
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDrag(null); return; }
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
        title={t('directorStudio.motion.timeline.resize')} data-director-tooltip={t('directorStudio.motion.timeline.resize')}
        className="absolute inset-x-0 top-0 z-30 flex h-1.5 cursor-ns-resize touch-none items-center justify-center outline-none hover:bg-accent/25 focus:bg-accent/25 focus:ring-2 focus:ring-inset focus:ring-accent/70"
        onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizeStartRef.current = { pointerId: event.pointerId, y: event.clientY, height }; }}
        onPointerMove={(event) => { const start = resizeStartRef.current; if (start?.pointerId === event.pointerId) timelineRef.current?.style.setProperty('height', `${clampHeight(start.height + start.y - event.clientY)}px`); }}
        onPointerUp={(event) => { const start = resizeStartRef.current; if (!start || start.pointerId !== event.pointerId) return; resizeStartRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); onHeightChange(clampHeight(start.height + start.y - event.clientY)); }}
        onPointerCancel={() => { resizeStartRef.current = null; timelineRef.current?.style.setProperty('height', `${height}px`); }}
        onKeyDown={(event) => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); event.stopPropagation(); onHeightChange(clampHeight(height + (event.key === 'ArrowUp' ? 20 : -20))); }}>
        <span className="h-0.5 w-10 rounded-full bg-white/30" />
      </div>

      <div className="ui-scrollbar flex h-[52px] shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 px-3 pt-1">
        <span className="mr-2 text-xs font-medium text-white/80">{t('directorStudio.motion.timeline.title')}</span>
        <button type="button" onClick={onGoToStart} className={buttonClass} aria-label={t('directorStudio.motion.timeline.goToStart')} {...tooltip('startHelp')}><Rewind className="h-4 w-4" /></button>
        <DirectorPlaybackButton playbackSource={playbackSource} onToggle={onTogglePlayback} />
        <button type="button" onClick={() => onLoopChange(!project.loop)} className={`${buttonClass} ${project.loop ? 'bg-accent/15 text-accent' : ''}`} aria-label={t('directorStudio.motion.timeline.loop')} aria-pressed={project.loop} {...tooltip('loopHelp')}><Repeat2 className="h-4 w-4" /></button>
        <label className="ml-2 flex shrink-0 items-center gap-1.5 text-[11px] text-white/60" title={t('directorStudio.motion.timeline.currentTime')}>
          <input ref={currentTimeInputRef} type="number" min={0} max={duration} step={1 / FRAME_RATE} defaultValue={timeSource.getSnapshot().toFixed(2)} aria-label={t('directorStudio.motion.timeline.currentTime')} className={inputClass}
            onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onTimeChange(clampTime(value, duration)); }}
            onBlur={(event) => { event.currentTarget.value = timeSource.getSnapshot().toFixed(2); }} />
          <span>/</span>
        </label>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-white/60" title={t('directorStudio.motion.timeline.duration')}>
          <input key={duration} type="number" min={0.5} max={30} step={0.5} defaultValue={duration} aria-label={t('directorStudio.motion.timeline.duration')} className={inputClass}
            onBlur={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) { const next = Math.min(30, Math.max(0.5, value)); event.currentTarget.value = String(next); if (next !== duration) onDurationChange(next); } else event.currentTarget.value = String(duration); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
          <span>s</span>
        </label>
        <select value={playbackRate} onChange={(event) => onPlaybackRateChange(Number(event.currentTarget.value))} className="ml-1 h-8 shrink-0 rounded border border-white/15 bg-[#202329] px-1 text-xs text-white/75 outline-none hover:border-white/30 focus:ring-2 focus:ring-accent/70" aria-label={t('directorStudio.previs.timeline.speed')} {...tooltip('speedHelp')}>
          {[0.25, 0.5, 1, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3">
          <button type="button" onClick={() => setSnapEnabled((value) => !value)} className={`${buttonClass} ${snapEnabled ? 'bg-accent/15 text-accent' : ''}`} aria-pressed={snapEnabled} {...tooltip('snapHelp')}><Magnet className="h-3.5 w-3.5" />{t('directorStudio.previs.timeline.snap')}</button>
          <span className="mx-1 h-5 w-px bg-white/10" />
          <button type="button" onClick={() => changeZoom(zoom / 2)} disabled={zoom <= 1 || isDragging} className={buttonClass} aria-label={t('directorStudio.previs.timeline.zoomOut')} {...tooltip('zoomOutHelp')}><Minus className="h-3.5 w-3.5" /></button>
          <span className="min-w-10 text-center font-mono text-[11px] text-white/60" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => changeZoom(zoom * 2)} disabled={zoom >= 16 || isDragging} className={buttonClass} aria-label={t('directorStudio.previs.timeline.zoomIn')} {...tooltip('zoomInHelp')}><Plus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => changeZoom(1)} disabled={isDragging} className={buttonClass} {...tooltip('fitHelp')}>{t('directorStudio.previs.timeline.fit')}</button>
        </div>
      </div>

      <div ref={scrollRef} className="ui-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain">
        <div style={{ width: LABEL_WIDTH + laneWidth + 20, minWidth: '100%' }}>
          <div className="sticky top-0 z-20 flex h-8 border-b border-white/10 bg-[#202329]">
            <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-white/10 bg-[#202329] px-3 text-[11px] font-medium text-white/60" style={{ width: LABEL_WIDTH }}>{t('directorStudio.motion.timeline.tracks')}</div>
            <div tabIndex={0} role="group" className="relative shrink-0 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70" style={{ width: laneWidth }} title={t('directorStudio.motion.timeline.scrubHelp')} data-director-tooltip={t('directorStudio.motion.timeline.scrubHelp')} aria-label={t('directorStudio.motion.timeline.scrubHelp')}
              onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey)); }}
              onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey)); }}
              onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
              {tickTimes.map((time, index) => <span key={index} className="pointer-events-none absolute inset-y-0 border-l border-white/15 pl-1 font-mono text-[11px] leading-8 text-white/55" style={{ left: `${time / duration * 100}%` }}><span className={time === duration ? 'absolute right-1' : undefined}>{`${Number(time.toFixed(2))}s`}</span></span>)}
              <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent" style={{ left: 'var(--director-motion-playhead, 0%)' }}><span className="absolute -left-1 top-0 h-2.5 w-2.5 rounded-b-sm bg-accent" /></span>
            </div>
          </div>
          {rows.map((row) => {
            const activeDrag = dragState?.selection.kind === row.kind && dragState.selection.trackId === row.trackId ? dragState : null;
            const displayedFrames = activeDrag?.mode === 'track'
              ? retimeDirectorTrack(row.keyframes, activeDrag.nextStart, activeDrag.nextEnd, duration)
              : activeDrag?.mode === 'keyframe'
                ? row.keyframes.map((frame) => frame.id === activeDrag.selection.keyframeId ? { ...frame, time: activeDrag.time } : frame).sort((a, b) => a.time - b.time)
                : row.keyframes;
            const hasRouteClip = row.kind !== 'action' && displayedFrames.length >= 2 && displayedFrames[displayedFrames.length - 1].time > displayedFrames[0].time;
            const clipStart = hasRouteClip ? displayedFrames[0].time : 0;
            const clipEnd = hasRouteClip ? displayedFrames[displayedFrames.length - 1].time : 0;
            const selectedTrack = selectedRowKey === row.key;
            return (
              <div key={row.key} className={`flex h-[64px] border-b border-white/[0.07] ${selectedTrack ? 'bg-accent/[0.035]' : ''}`} data-timeline-track={row.key}>
                <div className={`sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-white/10 pl-2 pr-1 ${selectedTrack ? 'bg-[#243332] shadow-[inset_3px_0_0_rgb(78,201,180)]' : 'bg-[#1c1f24]'}`} style={{ width: LABEL_WIDTH }}>
                  <div className="flex min-w-0 flex-1 flex-col items-start">
                    <button type="button" onClick={() => selectRow(row)} aria-pressed={selectedTrack} className={`${buttonClass} w-full min-w-0 justify-start px-1.5 text-left`} title={t('directorStudio.previs.timeline.selectTrackHelp', { name: row.label })} data-director-tooltip={t('directorStudio.previs.timeline.selectTrackHelp', { name: row.label })}>
                      {row.kind === 'camera' ? <Camera className="h-3.5 w-3.5 shrink-0 text-sky-200/75" /> : row.kind === 'action' ? <Sparkles className="ml-2 h-3.5 w-3.5 shrink-0 text-amber-200/70" /> : <UserRound className="h-3.5 w-3.5 shrink-0 text-white/55" />}
                      <span className="truncate">{row.label}</span>
                    </button>
                    {row.keyframes.length > 0 ? <button type="button" onClick={() => zoomToTrackKeyframes(row)} disabled={isDragging} className="max-w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/50 transition-colors hover:bg-white/10 hover:text-accent active:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-30" title={t('directorStudio.previs.timeline.keyframeCountHelp')} data-director-tooltip={t('directorStudio.previs.timeline.keyframeCountHelp')} aria-label={t('directorStudio.previs.timeline.keyframeCountAria', { name: row.label, count: row.keyframes.length })}>{t('directorStudio.previs.timeline.keyframeCount', { count: row.keyframes.length })}</button> : null}
                  </div>
                  <button type="button" onClick={() => { selectRow(row); row.onAdd(); }} className={`${buttonClass} w-8 px-0`} aria-label={`${row.label} · ${t('directorStudio.motion.timeline.addKeyframe')}`} {...tooltip(row.kind === 'action' ? 'addActionHelp' : 'addKeyframeHelp')}><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <div data-timeline-lane className="relative shrink-0 cursor-crosshair touch-none" style={{ width: laneWidth, backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: `${tickInterval / duration * laneWidth}px 100%` }}
                  onPointerDown={(event) => { if (event.button !== 0) return; selectRow(row); onTimeChange(timeFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), event.altKey)); }}>
                  {hasRouteClip ? (
                    <div className={`absolute top-1.5 h-7 rounded border ${row.kind === 'camera' ? 'border-sky-200/30 bg-sky-300/15' : 'border-accent/35 bg-accent/15'} ${selectedTrack ? 'ring-1 ring-accent/50' : ''}`} style={{ left: `${clipStart / duration * 100}%`, width: `${(clipEnd - clipStart) / duration * 100}%` }}>
                      <button type="button" onPointerDown={(event) => beginTrackDrag(event, row, 'move')} onClick={(event) => { if (event.detail === 0) selectRow(row); }} onKeyDown={(event) => moveTrackWithKeyboard(event, row, 'move')} className="absolute inset-0 w-full cursor-grab rounded px-4 text-left text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 active:cursor-grabbing active:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title={t('directorStudio.previs.timeline.routeHelp')} data-director-tooltip={t('directorStudio.previs.timeline.routeHelp')} aria-label={t('directorStudio.motion.timeline.routeClipAria', { name: row.label, start: clipStart.toFixed(2), end: clipEnd.toFixed(2) })}>
                        <span className="block truncate">{t('directorStudio.motion.timeline.routeClip', { start: clipStart.toFixed(2), end: clipEnd.toFixed(2) })}</span>
                      </button>
                      {(clipEnd - clipStart) / duration * laneWidth >= 36 ? (['start', 'end'] as const).map((handle) => <button key={handle} type="button" onPointerDown={(event) => beginTrackDrag(event, row, handle)} onClick={(event) => { if (event.detail === 0) selectRow(row); }} onKeyDown={(event) => moveTrackWithKeyboard(event, row, handle)} className={`absolute inset-y-0 z-10 w-3 cursor-ew-resize bg-white/10 transition-colors hover:bg-white/35 active:bg-white/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${handle === 'start' ? 'left-0 rounded-l border-r border-white/20' : 'right-0 rounded-r border-l border-white/20'}`} title={t(`directorStudio.previs.timeline.${handle === 'start' ? 'startHandleHelp' : 'endHelp'}`)} data-director-tooltip={t(`directorStudio.previs.timeline.${handle === 'start' ? 'startHandleHelp' : 'endHelp'}`)} aria-label={`${row.label} · ${t(`directorStudio.motion.timeline.${handle === 'start' ? 'trimStart' : 'trimEnd'}`)}`} />) : null}
                    </div>
                  ) : null}
                  {row.kind === 'action' ? displayedFrames.map((frame, index) => {
                    const end = displayedFrames[index + 1]?.time ?? duration;
                    const labelKey = frame.actionId ? actionLabels.get(frame.actionId) : frame.poseId ? poseLabels.get(frame.poseId) : undefined;
                    const actionLabel = frame.clipId ? project.customClips.find((clip) => clip.id === frame.clipId)?.name ?? t('directorStudio.motion.timeline.actionClip') : labelKey ? t(labelKey) : t('directorStudio.motion.timeline.actionClip');
                    const selected = selection?.kind === 'action' && selection.trackId === row.trackId && selection.keyframeId === frame.id;
                    return <button key={`action:${frame.id}`} type="button" onPointerDown={(event) => beginKeyframeDrag(event, row, frame)} onClick={(event) => { if (event.detail === 0) { selectRow(row, frame); onTimeChange(frame.time); } }} onKeyDown={(event) => moveFrameWithKeyboard(event, row, frame)} className={`absolute top-1.5 h-7 cursor-grab truncate rounded border border-amber-200/25 bg-amber-300/15 px-2 text-left text-[11px] text-amber-100/90 transition-colors hover:bg-amber-300/25 active:cursor-grabbing active:bg-amber-300/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'ring-1 ring-amber-200/70' : ''}`} style={{ left: `${frame.time / duration * 100}%`, width: `${Math.max(0, end - frame.time) / duration * 100}%` }} title={t('directorStudio.previs.timeline.actionHelp', { name: actionLabel })} data-director-tooltip={t('directorStudio.previs.timeline.actionHelp', { name: actionLabel })} aria-label={`${row.label} · ${actionLabel} · ${frame.time.toFixed(2)}s`} aria-pressed={selected}>{actionLabel}</button>;
                  }) : null}
                  {displayedFrames.length === 0 ? <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-[11px] text-white/30">{t(`directorStudio.previs.timeline.${row.kind === 'action' ? 'emptyAction' : 'emptyTrack'}`)}</span> : null}
                  {displayedFrames.map((frame, index) => {
                    const selected = selection?.kind === row.kind && selection.trackId === row.trackId && selection.keyframeId === frame.id;
                    const previous = displayedFrames[index - 1];
                    const next = displayedFrames[index + 1];
                    const neighborGap = Math.min(previous ? frame.time - previous.time : Infinity, next ? next.time - frame.time : Infinity) / duration * laneWidth;
                    const compact = !selected && neighborGap < 24;
                    const markerWidth = neighborGap < 7 ? 'w-0.5' : 'w-1.5';
                    const edgeInset = compact ? 3 : 11;
                    const label = t('directorStudio.motion.timeline.keyframeAria', { name: row.label, index: index + 1, time: frame.time.toFixed(2) });
                    return <button key={frame.id} type="button" onPointerDown={(event) => beginKeyframeDrag(event, row, frame)} onClick={(event) => { if (event.detail === 0) { selectRow(row, frame); onTimeChange(frame.time); } }} onKeyDown={(event) => moveFrameWithKeyboard(event, row, frame)} className={`group absolute flex -translate-x-1/2 cursor-ew-resize items-center justify-center rounded border text-[11px] font-medium shadow-sm transition-colors hover:z-[11] hover:bg-[#505a61] active:bg-accent/40 focus-visible:z-[11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${compact ? `top-[43px] z-[5] h-3 ${markerWidth} hover:top-[38px] hover:h-[22px] hover:w-[22px] focus-visible:top-[38px] focus-visible:h-[22px] focus-visible:w-[22px]` : 'top-[38px] h-[22px] w-[22px]'} ${selected ? 'z-[9] border-accent bg-[#365d56] text-white' : 'border-white/30 bg-[#59636c] text-white/85'}`} style={{ left: `clamp(${edgeInset}px, ${frame.time / duration * 100}%, calc(100% - ${edgeInset}px))` }} title={`${label}. ${t('directorStudio.previs.timeline.keyframeHelp')}`} data-director-tooltip={`${label}. ${t('directorStudio.previs.timeline.keyframeHelp')}`} aria-label={label} aria-pressed={selected}><span className={compact ? 'pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' : 'pointer-events-none'}>{index + 1}</span></button>;
                  })}
                  <div className="pointer-events-none absolute inset-y-0 z-[6] w-px bg-accent/75" style={{ left: 'var(--director-motion-playhead, 0%)' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
