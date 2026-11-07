import { useRef, useState } from 'react';
import { Copy, Layers, Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DirectorCameraRig } from '@/features/canvas/domain/canvasNodes';
import { snapStageTimelineTime } from '../application/timelineSnap';

export interface StageRigTimelineActions {
  edit(id: string, operation: 'split' | 'duplicate' | 'front'): void;
  retime(id: string, start: number, end: number, copy: boolean): void;
}
export function StageRigTimeline({ rigs, duration, laneWidth, labelWidth, playhead, actions }: {
  rigs: DirectorCameraRig[]; duration: number; laneWidth: number; labelWidth: number; playhead: () => number; actions: StageRigTimelineActions;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ id: string; start: number; end: number } | null>(null);
  const drag = useRef<{ id: string; x: number; start: number; end: number; mode: 'move' | 'start' | 'end'; copy: boolean; nextStart: number; nextEnd: number } | null>(null);
  const move = (x: number, bypass: boolean) => {
    const current = drag.current; if (!current) return;
    const delta = (x - current.x) / laneWidth * duration;
    const snap = (value: number) => bypass ? value : snapStageTimelineTime(value, duration, laneWidth, rigs.filter((rig) => rig.id !== current.id).flatMap((rig) => [rig.start, rig.end]), playhead());
    const span = current.end - current.start;
    const start = current.mode === 'end' ? current.start : Math.max(0, Math.min(current.mode === 'move' ? duration - span : current.end - 0.2, snap(current.start + delta)));
    const end = current.mode === 'move' ? start + span : current.mode === 'start' ? current.end : Math.min(duration, Math.max(start + 0.2, snap(current.end + delta)));
    drag.current = { ...current, nextStart: start, nextEnd: end }; setDraft({ id: current.id, start, end });
  };
  return <>{rigs.map((rig) => {
    const shown = draft?.id === rig.id ? draft : rig;
    const startDrag = (event: React.PointerEvent<HTMLButtonElement>, mode: 'move' | 'start' | 'end') => {
      event.stopPropagation(); if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: rig.id, x: event.clientX, start: rig.start, end: rig.end, mode, copy: mode === 'move' && (event.metaKey || event.ctrlKey), nextStart: rig.start, nextEnd: rig.end };
    };
    const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!drag.current) return; move(event.clientX, event.altKey); const current = drag.current;
      drag.current = null; setDraft(null);
      if (current && (Math.abs(current.nextStart - current.start) > 0.0001 || Math.abs(current.nextEnd - current.end) > 0.0001)) actions.retime(rig.id, current.nextStart, current.nextEnd, current.copy);
    };
    return <div key={rig.id} className="flex h-10 border-b border-line" data-rig-track={rig.id}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-surface px-2" style={{ width: labelWidth }}>
        <span className="min-w-0 flex-1 truncate text-xs">{t(`directorStudio.previs.rig.${rig.kind === 'closeup' ? 'closeup' : 'follow'}`)}</span>
        {([['split', Scissors], ['duplicate', Copy], ['front', Layers]] as const).map(([operation, Icon]) => <button type="button" key={operation} className="rounded p-1 text-text-muted hover:bg-raised" aria-label={t(`ui.stage.rig.${operation}`)} onClick={() => actions.edit(rig.id, operation)}><Icon className="h-3.5 w-3.5" /></button>)}
      </div>
      <div className="relative shrink-0" style={{ width: laneWidth }}>
        <div className="absolute inset-y-2 rounded-md border border-accent/50 bg-accent/20" style={{ left: shown.start / duration * laneWidth, width: (shown.end - shown.start) / duration * laneWidth, zIndex: Math.min(rig.priority ?? 0, 10) }}>
          {(['move', 'start', 'end'] as const).map((mode) => <button type="button" key={mode} aria-label={`${t('ui.stage.rig.priority')} ${rig.priority ?? 0} · ${mode === 'move' ? t('directorStudio.motion.timeline.routeClip', { start: shown.start.toFixed(1), end: shown.end.toFixed(1) }) : t(`directorStudio.motion.timeline.${mode === 'start' ? 'trimStart' : 'trimEnd'}`)}`}
            className={mode === 'move' ? 'absolute inset-0 cursor-grab overflow-hidden px-3 text-left font-mono text-[10px]' : `absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-accent/20 ${mode === 'start' ? 'left-0' : 'right-0'}`}
            onPointerDown={(event) => startDrag(event, mode)} onPointerMove={(event) => { if (drag.current?.id === rig.id) move(event.clientX, event.altKey); }} onPointerUp={endDrag}
            onPointerCancel={() => { drag.current = null; setDraft(null); }}
            onKeyDown={(event) => { if (event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); actions.edit(rig.id, 'split'); } }}>
            {mode === 'move' ? `${shown.start.toFixed(1)} → ${shown.end.toFixed(1)}s` : null}
          </button>)}
        </div>
      </div>
    </div>;
  })}</>;
}
