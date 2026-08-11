import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Camera,
  Clapperboard,
  Crosshair,
  Eye,
  EyeOff,
  Pause,
  Play,
  Plus,
  Repeat2,
  Rewind,
  Route,
  Sparkles,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BlueprintItem, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import { DIRECTOR_CAMERA_PRESETS, type DirectorCameraPresetId } from '@/features/canvas/application/directorMotion';
import {
  DirectorMotionInspector,
  type DirectorKeyframePatch,
  type DirectorKeyframeSelection,
} from './DirectorMotionInspector';

type Props = {
  height: number;
  project: DirectorMotionProjectV1;
  items: BlueprintItem[];
  timeSource: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => number;
  };
  playbackSource: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => boolean;
  };
  selection: DirectorKeyframeSelection | null;
  showRoutes: boolean;
  previewMode: 'route' | 'shot';
  pilotActive: boolean;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  onGoToStart: () => void;
  onLoopChange: (loop: boolean) => void;
  onDurationChange: (duration: number) => void;
  onSelectionChange: (selection: DirectorKeyframeSelection | null) => void;
  onMoveKeyframe: (selection: DirectorKeyframeSelection, time: number) => void;
  onPatchKeyframe: (selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => void;
  onDuplicateKeyframe: (selection: DirectorKeyframeSelection) => void;
  onDeleteKeyframe: (selection: DirectorKeyframeSelection) => void;
  onAddCameraKeyframe: () => void;
  onAddObjectKeyframe: (itemId: string) => void;
  onAddActionKeyframe: (itemId: string) => void;
  onShowRoutesChange: (show: boolean) => void;
  onPreviewModeChange: (mode: 'route' | 'shot') => void;
  onTogglePilot: () => void;
  onOpenActionLibrary: () => void;
  onOpenExport: () => void;
  onApplyCameraPreset: (presetId: DirectorCameraPresetId) => void;
  onClose: () => void;
};

const DirectorPlaybackButton = memo(function DirectorPlaybackButton({
  playbackSource,
  onToggle,
}: {
  playbackSource: Props['playbackSource'];
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isPlaying = useSyncExternalStore(
    playbackSource.subscribe,
    playbackSource.getSnapshot,
    playbackSource.getSnapshot,
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-8 w-8 items-center justify-center rounded bg-white text-black hover:bg-white/88 focus:outline-none focus:ring-2 focus:ring-accent/70"
      title={isPlaying ? t('directorStudio.motion.timeline.pause') : t('directorStudio.motion.timeline.play')}
      aria-label={isPlaying ? t('directorStudio.motion.timeline.pause') : t('directorStudio.motion.timeline.play')}
    >
      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
    </button>
  );
});

type TrackRow = {
  key: string;
  kind: 'camera' | 'object' | 'action';
  trackId: string;
  label: string;
  keyframes: Array<{ id: string; time: number }>;
  onAdd: () => void;
};

type DragState = {
  selection: DirectorKeyframeSelection;
  rect: DOMRect;
  time: number;
};

function clampTime(time: number, duration: number): number {
  return Math.min(duration, Math.max(0, time));
}

export const DirectorTimeline = memo(function DirectorTimeline({
  height,
  project,
  items,
  timeSource,
  playbackSource,
  selection,
  showRoutes,
  previewMode,
  pilotActive,
  onTimeChange,
  onTogglePlayback,
  onGoToStart,
  onLoopChange,
  onDurationChange,
  onSelectionChange,
  onMoveKeyframe,
  onPatchKeyframe,
  onDuplicateKeyframe,
  onDeleteKeyframe,
  onAddCameraKeyframe,
  onAddObjectKeyframe,
  onAddActionKeyframe,
  onShowRoutesChange,
  onPreviewModeChange,
  onTogglePilot,
  onOpenActionLibrary,
  onOpenExport,
  onApplyCameraPreset,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLElement | null>(null);
  const currentTimeInputRef = useRef<HTMLInputElement | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;

  const rows = useMemo<TrackRow[]>(() => {
    const result: TrackRow[] = [{
      key: 'camera',
      kind: 'camera',
      trackId: 'camera',
      label: t('directorStudio.motion.timeline.camera'),
      keyframes: project.cameraTrack,
      onAdd: onAddCameraKeyframe,
    }];
    items.forEach((item) => {
      result.push({
        key: `object:${item.id}`,
        kind: 'object',
        trackId: item.id,
        label: item.label,
        keyframes: project.objectTracks[item.id] ?? [],
        onAdd: () => onAddObjectKeyframe(item.id),
      });
      if (item.category === 'person') {
        result.push({
          key: `action:${item.id}`,
          kind: 'action',
          trackId: item.id,
          label: t('directorStudio.motion.timeline.actionTrack', { name: item.label }),
          keyframes: project.actionTracks[item.id] ?? [],
          onAdd: () => onAddActionKeyframe(item.id),
        });
      }
    });
    return result;
  }, [items, onAddActionKeyframe, onAddCameraKeyframe, onAddObjectKeyframe, project.actionTracks, project.cameraTrack, project.objectTracks, t]);

  const timeFromPointer = useCallback((clientX: number, rect: DOMRect) => {
    return clampTime(((clientX - rect.left) / Math.max(1, rect.width)) * project.durationSeconds, project.durationSeconds);
  }, [project.durationSeconds]);

  useEffect(() => {
    if (!dragState) return;
    const handleMove = (event: PointerEvent) => {
      const active = dragStateRef.current;
      if (!active) return;
      setDragState({ ...active, time: timeFromPointer(event.clientX, active.rect) });
    };
    const handleUp = () => {
      const active = dragStateRef.current;
      if (active) onMoveKeyframe(active.selection, active.time);
      setDragState(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    window.addEventListener('pointercancel', handleUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragState, onMoveKeyframe, timeFromPointer]);

  const beginKeyframeDrag = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    nextSelection: DirectorKeyframeSelection,
    time: number,
  ) => {
    event.stopPropagation();
    const lane = event.currentTarget.closest('[data-timeline-lane]');
    if (!(lane instanceof HTMLElement)) return;
    onSelectionChange(nextSelection);
    setDragState({ selection: nextSelection, rect: lane.getBoundingClientRect(), time });
  }, [onSelectionChange]);

  useEffect(() => {
    const syncPlaybackTime = () => {
      const time = clampTime(timeSource.getSnapshot(), project.durationSeconds);
      timelineRef.current?.style.setProperty(
        '--director-motion-playhead',
        `${(time / project.durationSeconds) * 100}%`,
      );
      if (currentTimeInputRef.current && document.activeElement !== currentTimeInputRef.current) {
        currentTimeInputRef.current.value = time.toFixed(2);
      }
    };
    syncPlaybackTime();
    return timeSource.subscribe(syncPlaybackTime);
  }, [project.durationSeconds, timeSource]);

  return (
    <section
      ref={timelineRef}
      className="ui-director-timeline-enter absolute inset-x-0 bottom-0 z-[64] flex flex-col border-t border-white/12 bg-[#0a0e10]/98 shadow-[0_-14px_40px_rgba(0,0,0,0.34)] backdrop-blur-xl"
      style={{ height }}
      aria-label={t('directorStudio.motion.timeline.title')}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 overflow-hidden border-b border-white/10 px-2">
        <button
          type="button"
          onClick={onGoToStart}
          className="flex h-8 w-8 items-center justify-center rounded text-white/62 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60"
          title={t('directorStudio.motion.timeline.goToStart')}
          aria-label={t('directorStudio.motion.timeline.goToStart')}
        >
          <Rewind className="h-4 w-4" />
        </button>
        <DirectorPlaybackButton playbackSource={playbackSource} onToggle={onTogglePlayback} />
        <button
          type="button"
          onClick={() => onLoopChange(!project.loop)}
          className={`flex h-8 w-8 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-accent/60 ${
            project.loop ? 'bg-accent/24 text-accent' : 'text-white/52 hover:bg-white/10 hover:text-white'
          }`}
          title={t('directorStudio.motion.timeline.loop')}
          aria-label={t('directorStudio.motion.timeline.loop')}
          aria-pressed={project.loop}
        >
          <Repeat2 className="h-4 w-4" />
        </button>
        <div className="ml-1 flex items-center gap-1 font-mono text-[11px] text-white/68" aria-live="polite">
          <input
            ref={currentTimeInputRef}
            type="number"
            min={0}
            max={project.durationSeconds}
            step={0.05}
            defaultValue={Number(timeSource.getSnapshot().toFixed(2))}
            onChange={(event) => onTimeChange(clampTime(Number(event.target.value) || 0, project.durationSeconds))}
            className="h-8 w-[62px] rounded border border-white/12 bg-black/22 px-2 text-right outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
            aria-label={t('directorStudio.motion.timeline.currentTime')}
          />
          <span>/</span>
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={project.durationSeconds}
            onChange={(event) => onDurationChange(Math.min(30, Math.max(0.5, Number(event.target.value) || 8)))}
            className="h-8 w-[58px] rounded border border-white/12 bg-black/22 px-2 text-right outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
            aria-label={t('directorStudio.motion.timeline.duration')}
          />
          <span className="text-white/38">s</span>
        </div>

        <div className="mx-1 hidden h-5 w-px bg-white/10 md:block" />
        <div className="hidden h-8 items-center rounded border border-white/10 bg-white/5 p-0.5 md:flex">
          <button
            type="button"
            onClick={() => onPreviewModeChange('route')}
            className={`flex h-7 w-8 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-accent/60 ${previewMode === 'route' ? 'bg-white text-black' : 'text-white/52 hover:text-white'}`}
            title={t('directorStudio.motion.timeline.routePreview')}
            aria-label={t('directorStudio.motion.timeline.routePreview')}
          ><Route className="h-3.5 w-3.5" /></button>
          <button
            type="button"
            onClick={() => onPreviewModeChange('shot')}
            className={`flex h-7 w-8 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-accent/60 ${previewMode === 'shot' ? 'bg-white text-black' : 'text-white/52 hover:text-white'}`}
            title={t('directorStudio.motion.timeline.shotPreview')}
            aria-label={t('directorStudio.motion.timeline.shotPreview')}
          ><Clapperboard className="h-3.5 w-3.5" /></button>
        </div>
        <button
          type="button"
          onClick={() => onShowRoutesChange(!showRoutes)}
          className={`hidden h-8 w-8 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-accent/60 md:flex ${showRoutes ? 'text-accent' : 'text-white/48 hover:bg-white/10 hover:text-white'}`}
          title={showRoutes ? t('directorStudio.motion.timeline.hideRoutes') : t('directorStudio.motion.timeline.showRoutes')}
          aria-label={showRoutes ? t('directorStudio.motion.timeline.hideRoutes') : t('directorStudio.motion.timeline.showRoutes')}
        >{showRoutes ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}</button>
        <button
          type="button"
          onClick={onOpenActionLibrary}
          className="hidden h-8 w-8 items-center justify-center rounded text-white/58 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60 md:flex"
          title={t('directorStudio.motion.library.title')}
          aria-label={t('directorStudio.motion.library.title')}
        ><UserRound className="h-4 w-4" /></button>
        <button
          type="button"
          onClick={onTogglePilot}
          className={`hidden h-8 w-8 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-accent/60 md:flex ${pilotActive ? 'bg-red-500/20 text-red-100' : 'text-white/58 hover:bg-white/10 hover:text-white'}`}
          title={pilotActive ? t('directorStudio.motion.pilot.exit') : t('directorStudio.motion.pilot.enter')}
          aria-label={pilotActive ? t('directorStudio.motion.pilot.exit') : t('directorStudio.motion.pilot.enter')}
        ><Crosshair className="h-4 w-4" /></button>
        <select
          defaultValue=""
          onChange={(event) => {
            if (!event.target.value) return;
            onApplyCameraPreset(event.target.value as DirectorCameraPresetId);
            event.target.value = '';
          }}
          className="hidden h-8 min-w-0 max-w-[148px] rounded border border-white/12 bg-[#111719] px-2 text-[10px] text-white/68 outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30 md:block"
          aria-label={t('directorStudio.motion.cameraPresets.title')}
        >
          <option value="">{t('directorStudio.motion.cameraPresets.title')}</option>
          {DIRECTOR_CAMERA_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{t(preset.labelKey)}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenExport}
            disabled={project.cameraTrack.length < 2}
            className="hidden h-8 items-center gap-1.5 rounded border border-white/12 bg-white/7 px-2.5 text-[10px] text-white/72 hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-accent/60 md:inline-flex"
            title={project.cameraTrack.length < 2 ? t('directorStudio.motion.export.needsCamera') : t('directorStudio.motion.export.title')}
          >
            <Video className="h-3.5 w-3.5" />
            {t('directorStudio.motion.export.title')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded text-white/45 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60"
            title={t('common.close')}
            aria-label={t('common.close')}
          ><X className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="ui-scrollbar min-w-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex h-6 border-b border-white/8 bg-[#0b1012]">
            <div className="w-[128px] shrink-0 border-r border-white/8 px-2 text-[9px] leading-6 text-white/32 md:w-[176px]">
              {t('directorStudio.motion.timeline.tracks')}
            </div>
            <div className="relative min-w-[260px] flex-1 md:min-w-[420px]">
              {Array.from({ length: Math.floor(project.durationSeconds) + 1 }, (_, second) => (
                <span
                  key={second}
                  className="absolute top-0 h-full border-l border-white/8 pl-1 font-mono text-[8px] leading-6 text-white/28"
                  style={{ left: `${(second / project.durationSeconds) * 100}%` }}
                >{second}</span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div key={row.key} className="flex h-7 border-b border-white/[0.055]">
              <div className="flex w-[128px] shrink-0 items-center gap-1 border-r border-white/8 px-2 md:w-[176px]">
                {row.kind === 'camera' ? <Camera className="h-3 w-3 text-sky-300/72" /> : row.kind === 'action' ? <Sparkles className="h-3 w-3 text-amber-300/72" /> : <UserRound className="h-3 w-3 text-white/42" />}
                <span className="min-w-0 flex-1 truncate text-[9px] text-white/58" title={row.label}>{row.label}</span>
                <button
                  type="button"
                  onClick={row.onAdd}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/38 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-accent/70"
                  title={t('directorStudio.motion.timeline.addKeyframe')}
                  aria-label={t('directorStudio.motion.timeline.addKeyframe')}
                ><Plus className="h-3 w-3" /></button>
              </div>
              <div
                data-timeline-lane
                className="relative min-w-[260px] flex-1 cursor-crosshair bg-[repeating-linear-gradient(to_right,transparent_0,transparent_calc(10%-1px),rgba(255,255,255,0.035)_calc(10%-1px),rgba(255,255,255,0.035)_10%)] md:min-w-[420px]"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onSelectionChange(null);
                  onTimeChange(timeFromPointer(event.clientX, rect));
                }}
              >
                {row.keyframes.map((keyframe) => {
                  const nextSelection: DirectorKeyframeSelection = { kind: row.kind, trackId: row.trackId, keyframeId: keyframe.id };
                  const isDragging = dragState?.selection.keyframeId === keyframe.id;
                  const displayTime = isDragging ? dragState.time : keyframe.time;
                  const selected = selection?.keyframeId === keyframe.id;
                  return (
                    <button
                      key={keyframe.id}
                      type="button"
                      onPointerDown={(event) => beginKeyframeDrag(event, nextSelection, keyframe.time)}
                      className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border focus:outline-none focus:ring-2 focus:ring-accent/70 ${
                        selected ? 'border-white bg-accent' : row.kind === 'camera' ? 'border-sky-200/80 bg-sky-400' : row.kind === 'action' ? 'border-amber-100/80 bg-amber-400' : 'border-white/75 bg-white/62'
                      }`}
                      style={{ left: `${(displayTime / project.durationSeconds) * 100}%` }}
                      title={`${row.label} · ${displayTime.toFixed(2)}s`}
                      aria-label={`${row.label} ${displayTime.toFixed(2)}s`}
                    />
                  );
                })}
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 w-px bg-red-400"
                  style={{ left: 'var(--director-motion-playhead, 0%)' }}
                />
              </div>
            </div>
          ))}
        </div>
        <DirectorMotionInspector
          project={project}
          selection={selection}
          onPatch={onPatchKeyframe}
          onDuplicate={onDuplicateKeyframe}
          onDelete={onDeleteKeyframe}
        />
      </div>
    </section>
  );
});
