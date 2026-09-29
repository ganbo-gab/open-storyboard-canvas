import { memo } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DIRECTOR_PROCEDURAL_ACTIONS,
  DIRECTOR_STATIC_POSES,
} from '@/features/canvas/application/directorMotion';
import type {
  BlueprintItem,
  DirectorActionKeyframe,
  DirectorCameraKeyframe,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
  DirectorObjectKeyframe,
} from '@/features/canvas/domain/canvasNodes';

export type DirectorMotionTrackKind = 'camera' | 'object' | 'action';

export interface DirectorKeyframeSelection {
  kind: DirectorMotionTrackKind;
  trackId: string;
  keyframeId: string;
}

export type DirectorKeyframePatch =
  | Partial<DirectorCameraKeyframe>
  | Partial<DirectorObjectKeyframe>
  | Partial<DirectorActionKeyframe>;

type Props = {
  project: DirectorMotionProjectV1;
  items: BlueprintItem[];
  selectedItemId: string | null;
  selection: DirectorKeyframeSelection | null;
  onSelectionChange: (selection: DirectorKeyframeSelection) => void;
  onTimeChange: (time: number) => void;
  onRetimeTrack: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onPatch: (selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => void;
  onDuplicate: (selection: DirectorKeyframeSelection) => void;
  onDelete: (selection: DirectorKeyframeSelection) => void;
  className?: string;
};

const FIELD_CLASS = 'h-8 w-full min-w-0 rounded border border-white/15 bg-[#171a1f] px-2 text-xs text-white outline-none transition-colors hover:border-white/30 focus:border-teal-400/70 focus:ring-1 focus:ring-teal-400/30';
const BUTTON_CLASS = 'inline-flex h-8 items-center justify-center gap-1.5 rounded border border-white/15 bg-white/5 text-xs text-white/80 transition-colors hover:border-teal-300/40 hover:bg-white/10 active:bg-teal-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60';

type NumberFieldProps = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  ariaLabel?: string;
};

/** Commit once when the edit finishes; playback never writes through these fields. */
export function DirectorInspectorNumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  precision = 2,
  ariaLabel,
}: NumberFieldProps) {
  const displayValue = Number(value.toFixed(precision));
  return (
    <label className="block min-w-0 text-xs text-white/60">
      <span className="mb-1.5 block">{label}</span>
      <input
        key={value}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={displayValue}
        aria-label={ariaLabel ?? label}
        onBlur={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (!Number.isFinite(next)) {
            event.currentTarget.value = String(displayValue);
            return;
          }
          const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, next));
          event.currentTarget.value = String(Number(clamped.toFixed(precision)));
          if (clamped !== displayValue) onCommit(clamped);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.value = String(displayValue);
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
        }}
        className={`${FIELD_CLASS} font-mono tabular-nums`}
      />
    </label>
  );
}

export function DirectorInspectorVectorFields({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  suffix = '',
}: {
  label: string;
  value: DirectorMotionVector3;
  onCommit: (axis: 'x' | 'y' | 'z', value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium text-white/80">{label}{suffix ? ` (${suffix})` : ''}</legend>
      <div className="grid grid-cols-3 gap-2">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <DirectorInspectorNumberField
            key={axis}
            label={axis.toUpperCase()}
            ariaLabel={`${label} ${axis.toUpperCase()}`}
            value={value[axis]}
            min={min}
            max={max}
            step={step}
            onCommit={(next) => onCommit(axis, next)}
          />
        ))}
      </div>
    </fieldset>
  );
}

export function getSelectedDirectorKeyframe(
  project: DirectorMotionProjectV1,
  selection: DirectorKeyframeSelection | null,
): DirectorCameraKeyframe | DirectorObjectKeyframe | DirectorActionKeyframe | null {
  if (!selection) return null;
  const track = selection.kind === 'camera'
    ? project.cameraTrack
    : selection.kind === 'object'
      ? project.objectTracks[selection.trackId] ?? []
      : project.actionTracks[selection.trackId] ?? [];
  return track.find((keyframe) => keyframe.id === selection.keyframeId) ?? null;
}

export const DirectorMotionInspector = memo(function DirectorMotionInspector({
  project,
  items,
  selectedItemId,
  selection,
  onSelectionChange,
  onTimeChange,
  onRetimeTrack,
  onPatch,
  onDuplicate,
  onDelete,
  className = '',
}: Props) {
  const { t } = useTranslation();
  const keyframe = getSelectedDirectorKeyframe(project, selection);
  const trackKind = selection?.kind ?? (selectedItemId ? 'object' : 'camera');
  const trackId = selection?.trackId ?? selectedItemId ?? 'camera';
  const track = trackKind === 'camera'
    ? project.cameraTrack
    : trackKind === 'object'
      ? project.objectTracks[trackId] ?? []
      : project.actionTracks[trackId] ?? [];
  const trackLabel = trackKind === 'camera'
    ? t('directorStudio.motion.timeline.camera')
    : items.find((item) => item.id === trackId)?.label ?? t('directorStudio.motion.timeline.tracks');
  const trackStart = track[0]?.time ?? 0;
  const trackEnd = track[track.length - 1]?.time ?? 0;
  const hasEditableClip = trackKind !== 'action' && track.length >= 2 && trackEnd - trackStart >= 0.1;
  const actionFrame = selection?.kind === 'action' && keyframe && !('position' in keyframe) ? keyframe : null;
  const action = DIRECTOR_PROCEDURAL_ACTIONS.find((entry) => entry.id === actionFrame?.actionId);
  const pose = DIRECTOR_STATIC_POSES.find((entry) => entry.id === actionFrame?.poseId);
  const clip = project.customClips.find((entry) => entry.id === actionFrame?.clipId);
  const actionLabel = action ? t(action.labelKey) : pose ? t(pose.labelKey)
    : clip?.name ?? actionFrame?.actionId ?? actionFrame?.poseId ?? t('directorStudio.motion.library.custom');

  return (
    <section className={`flex min-w-0 flex-col gap-4 text-xs ${className}`} aria-label={t('directorStudio.motion.inspector.title')}>
      <div className="rounded-md border border-white/10 bg-[#20242a] p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate font-semibold text-white">{trackLabel}</h3>
          <span className="shrink-0 text-white/50">{t('directorStudio.motion.inspector.trackSummary', { count: track.length })}</span>
        </div>
        {hasEditableClip ? (
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="mb-2 font-medium text-teal-200">{t('directorStudio.motion.timeline.routeClip', { start: trackStart.toFixed(1), end: trackEnd.toFixed(1) })}</div>
            <div className="grid grid-cols-2 gap-2">
              <DirectorInspectorNumberField
                label={t('directorStudio.motion.inspector.clipStart')}
                value={trackStart}
                min={0}
                max={trackEnd - 0.1}
                onCommit={(start) => onRetimeTrack(trackKind, trackId, start, trackEnd)}
              />
              <DirectorInspectorNumberField
                label={t('directorStudio.motion.inspector.clipEnd')}
                value={trackEnd}
                min={trackStart + 0.1}
                max={project.durationSeconds}
                onCommit={(end) => onRetimeTrack(trackKind, trackId, trackStart, end)}
              />
            </div>
            <p className="mt-2 leading-5 text-white/50">{t('directorStudio.motion.inspector.clipHelp')}</p>
          </div>
        ) : null}
      </div>
      {track.length > 0 ? (
        <label className="block text-white/60">
          <span className="mb-1.5 block">{t('directorStudio.motion.inspector.keyframes')}</span>
          <select
            value={keyframe?.id ?? ''}
            onChange={(event) => {
              const frame = track.find((entry) => entry.id === event.target.value);
              if (!frame) return;
              onSelectionChange({ kind: trackKind, trackId, keyframeId: frame.id });
              onTimeChange(frame.time);
            }}
            className={FIELD_CLASS}
          >
            <option value="" disabled>{t('directorStudio.motion.inspector.empty')}</option>
            {track.map((frame, index) => (
              <option key={frame.id} value={frame.id}>
                {t('directorStudio.motion.inspector.keyframeNumber', { index: index + 1 })} · {frame.time.toFixed(2)}s
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!selection || !keyframe ? (
        <p className="leading-5 text-white/55">{t(track.length ? 'directorStudio.motion.inspector.empty' : 'directorStudio.motion.inspector.emptyTrack')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <DirectorInspectorNumberField
              key={`${selection.keyframeId}:time`}
              label={t('directorStudio.motion.inspector.time')}
              value={keyframe.time}
              min={0}
              max={project.durationSeconds}
              step={0.05}
              precision={3}
              onCommit={(time) => { onPatch(selection, { time }); onTimeChange(time); }}
            />
            <label className="block text-white/60">
              <span className="mb-1.5 block">{t('directorStudio.motion.inspector.easing')}</span>
              <select
                value={keyframe.easing}
                onChange={(event) => onPatch(selection, { easing: event.target.value === 'smooth' ? 'smooth' : 'linear' })}
                className={FIELD_CLASS}
              >
                <option value="linear">{t('directorStudio.motion.inspector.linear')}</option>
                <option value="smooth">{t('directorStudio.motion.inspector.smooth')}</option>
              </select>
            </label>
          </div>
          {'position' in keyframe ? (
            <DirectorInspectorVectorFields
              key={`${selection.keyframeId}:position`}
              label={t('directorStudio.motion.inspector.position')}
              value={keyframe.position}
              onCommit={(axis, value) => onPatch(selection, { position: { ...keyframe.position, [axis]: value } })}
            />
          ) : null}
          {selection.kind === 'camera' && 'fov' in keyframe ? (
            <div className="space-y-4 border-t border-white/10 pt-4">
              <DirectorInspectorNumberField
                key={`${selection.keyframeId}:fov`}
                label={t('directorStudio.motion.inspector.fov')}
                value={keyframe.fov}
                min={10}
                max={150}
                onCommit={(fov) => onPatch(selection, { fov })}
              />
              <label className="block text-white/60">
                <span className="mb-1.5 block">{t('directorStudio.motion.inspector.targetMode')}</span>
                <select
                  value={keyframe.trackTargetId ?? ''}
                  onChange={(event) => onPatch(selection, { trackTargetId: event.target.value || null })}
                  className={FIELD_CLASS}
                >
                  <option value="">{t('directorStudio.motion.inspector.fixedTarget')}</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{t('directorStudio.previs.followObject', { name: item.label })}</option>)}
                </select>
              </label>
              {keyframe.trackTargetId ? (
                <label className="block text-white/60">
                  <span className="mb-1.5 block">{t('directorStudio.motion.inspector.targetBodyPart')}</span>
                  <select
                    value={keyframe.trackTargetBodyPart ?? 'torso'}
                    onChange={(event) => onPatch(selection, { trackTargetBodyPart: event.target.value })}
                    className={FIELD_CLASS}
                  >
                    {(['head', 'torso', 'feet'] as const).map((part) => (
                      <option key={part} value={part}>{t(`directorStudio.motion.inspector.${part}`)}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <DirectorInspectorVectorFields
                  key={`${selection.keyframeId}:target`}
                  label={t('directorStudio.motion.inspector.fixedTarget')}
                  value={keyframe.target}
                  onCommit={(axis, value) => onPatch(selection, { target: { ...keyframe.target, [axis]: value } })}
                />
              )}
            </div>
          ) : null}
          {selection.kind === 'object' && 'rotation' in keyframe ? (
            <div className="space-y-4 border-t border-white/10 pt-4">
              <label className="flex items-center justify-between gap-3 text-white/75">
                <span>{t('directorStudio.motion.inspector.orientToPath')}</span>
                <input
                  type="checkbox"
                  checked={keyframe.orientToPath === true}
                  onChange={(event) => onPatch(selection, { orientToPath: event.target.checked })}
                  className="h-4 w-4 accent-teal-400 focus-visible:outline-teal-400"
                />
              </label>
              <DirectorInspectorNumberField
                key={`${selection.keyframeId}:yaw`}
                label={`${t('directorStudio.motion.inspector.yaw')} (°)`}
                value={keyframe.rotation.y * 180 / Math.PI}
                step={5}
                precision={1}
                onCommit={(value) => onPatch(selection, { rotation: { ...keyframe.rotation, y: value * Math.PI / 180 } })}
              />
            </div>
          ) : null}
          {actionFrame ? (
            <div className="rounded-md border border-teal-300/15 bg-teal-400/5 p-3">
              <div className="mb-1 text-white/55">{t('directorStudio.inspector.action')}</div>
              <div className="font-medium text-teal-100">{actionLabel}</div>
            </div>
          ) : null}
          <div className="flex gap-2 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => onDuplicate(selection)}
              className={`${BUTTON_CLASS} flex-1`}
              title={t('directorStudio.previs.duplicateFrameHelp')}
              data-director-tooltip={t('directorStudio.previs.duplicateFrameHelp')}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('directorStudio.motion.inspector.duplicate')}
            </button>
            <button
              type="button"
              onClick={() => onDelete(selection)}
              className={`${BUTTON_CLASS} w-8 text-red-200 hover:border-red-300/40 hover:bg-red-500/15 active:bg-red-500/25`}
              title={t('directorStudio.motion.inspector.delete')}
              data-director-tooltip={t('directorStudio.motion.inspector.delete')}
              aria-label={t('directorStudio.motion.inspector.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </section>
  );
});
