import { memo } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiIconButton, UiSegmented, UiSelect } from '@/components/ui';
import { ScrubNumber, VectorField } from '@/features/stage/ui/stageKit';

import { PERSON_ACTIONS, PERSON_POSES } from '@/features/canvas/application/personMotionLibrary';
import type {
  BlueprintItem,
  DirectorMotionEasing,
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

const FIELD_CLASS = 'h-8 w-full min-w-0 px-2 text-xs';
const DEG = 180 / Math.PI;
const EASING_OPTIONS: readonly DirectorMotionEasing[] = ['linear', 'smooth', 'hold'];

type CameraLookMode = 'target' | 'point' | 'free';

/**
 * Euler XYZ (radians, z = 0) that turns the camera's forward axis (0, 0, -1) towards `target`.
 * Mirrors `sampleCameraTrack`: R = Rx·Ry, so forward = (-sin y, sin x·cos y, -cos x·cos y).
 */
export function freeRotationFromLook(position: DirectorMotionVector3, target: DirectorMotionVector3): DirectorMotionVector3 {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return { x: 0, y: 0, z: 0 };
  const y = Math.asin(Math.max(-1, Math.min(1, -dx / length)));
  const x = Math.atan2(dy / length, -dz / length);
  return { x, y, z: 0 };
}

/** Inverse of {@link freeRotationFromLook}: the point `distance` ahead of the camera. */
export function lookPointFromRotation(position: DirectorMotionVector3, rotation: DirectorMotionVector3, distance: number): DirectorMotionVector3 {
  const forward = { x: -Math.sin(rotation.y), y: Math.sin(rotation.x) * Math.cos(rotation.y), z: -Math.cos(rotation.x) * Math.cos(rotation.y) };
  return { x: position.x + forward.x * distance, y: position.y + forward.y * distance, z: position.z + forward.z * distance };
}

function cameraLookMode(keyframe: DirectorCameraKeyframe): CameraLookMode {
  if (keyframe.freeRotation) return 'free';
  return keyframe.trackTargetId ? 'target' : 'point';
}


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
  return (
    <label className="block min-w-0 text-xs text-text-muted">
      <span className="mb-1.5 block">{label}</span>
      <ScrubNumber label="↔" ariaLabel={ariaLabel ?? label} value={value} min={min} max={max} step={step} precision={precision} onCommit={onCommit} />
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
  return <VectorField label={label} value={value} min={min} max={max} step={step} suffix={suffix || undefined} onCommit={onCommit} />;
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
  const action = PERSON_ACTIONS.find((entry) => entry.id === actionFrame?.actionId);
  const pose = PERSON_POSES.find((entry) => entry.id === actionFrame?.poseId);
  const clip = project.customClips.find((entry) => entry.id === actionFrame?.clipId);
  const actionLabel = action ? t(action.labelKey) : pose ? t(pose.labelKey)
    : clip?.name ?? actionFrame?.actionId ?? actionFrame?.poseId ?? t('directorStudio.motion.library.custom');

  return (
    <section className={`flex min-w-0 flex-col gap-4 text-xs ${className}`} aria-label={t('directorStudio.motion.inspector.title')}>
      <div className="rounded-md border border-[var(--line)] bg-elevated p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate font-semibold text-text-dark">{trackLabel}</h3>
          <span className="shrink-0 text-text-subtle">{t('directorStudio.motion.inspector.trackSummary', { count: track.length })}</span>
        </div>
        {hasEditableClip ? (
          <div className="mt-3 border-t border-[var(--line)] pt-3">
            <div className="mb-2 font-medium text-accent">{t('directorStudio.motion.timeline.routeClip', { start: trackStart.toFixed(1), end: trackEnd.toFixed(1) })}</div>
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
            <p className="mt-2 leading-5 text-text-subtle">{t('directorStudio.motion.inspector.clipHelp')}</p>
          </div>
        ) : null}
      </div>
      {track.length > 0 ? (
        <label className="block text-text-muted">
          <span className="mb-1.5 block">{t('directorStudio.motion.inspector.keyframes')}</span>
          <UiSelect
            value={keyframe?.id ?? ''}
            aria-label={t('directorStudio.motion.inspector.keyframes')}
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
          </UiSelect>
        </label>
      ) : null}
      {!selection || !keyframe ? (
        <p className="leading-5 text-text-muted">{t(track.length ? 'directorStudio.motion.inspector.empty' : 'directorStudio.motion.inspector.emptyTrack')}</p>
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
            <label className="block text-text-muted">
              <span className="mb-1.5 block">{t('directorStudio.motion.inspector.easing')}</span>
              <UiSelect
                value={keyframe.easing}
                aria-label={t('directorStudio.motion.inspector.easing')}
                onChange={(event) => { const easing = EASING_OPTIONS.find((entry) => entry === event.target.value); if (easing) onPatch(selection, { easing }); }}
                className={FIELD_CLASS}
              >
                {EASING_OPTIONS.map((easing) => <option key={easing} value={easing}>{t(`directorStudio.motion.inspector.${easing}`)}</option>)}
              </UiSelect>
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
            <div className="space-y-4 border-t border-[var(--line)] pt-4">
              <DirectorInspectorNumberField
                key={`${selection.keyframeId}:fov`}
                label={t('directorStudio.motion.inspector.fov')}
                value={keyframe.fov}
                min={10}
                max={150}
                onCommit={(fov) => onPatch(selection, { fov })}
              />
              <CameraLookFields
                keyframe={keyframe}
                items={items}
                onPatch={(patch) => onPatch(selection, patch)}
              />
            </div>
          ) : null}
          {selection.kind === 'object' && 'rotation' in keyframe ? (
            <div className="space-y-4 border-t border-[var(--line)] pt-4">
              <label className="flex items-center justify-between gap-3 text-text-muted">
                <span>{t('directorStudio.motion.inspector.orientToPath')}</span>
                <UiCheckbox
                  checked={keyframe.orientToPath === true}
                  onCheckedChange={(checked) => onPatch(selection, { orientToPath: checked })}
                  aria-label={t('directorStudio.motion.inspector.orientToPath')}
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
            <div className="rounded-md border border-accent/15 bg-accent/5 p-3">
              <div className="mb-1 text-text-muted">{t('directorStudio.inspector.action')}</div>
              <div className="font-medium text-accent">{actionLabel}</div>
            </div>
          ) : null}
          <div className="flex gap-2 border-t border-[var(--line)] pt-3">
            <UiButton variant="secondary" size="sm"
              type="button"
              onClick={() => onDuplicate(selection)}
              className="flex-1"
              title={t('directorStudio.previs.duplicateFrameHelp')}
              data-director-tooltip={t('directorStudio.previs.duplicateFrameHelp')}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('directorStudio.motion.inspector.duplicate')}
            </UiButton>
            <UiIconButton size="sm"
              type="button"
              onClick={() => onDelete(selection)}
              className="w-8 text-danger hover:text-danger"
              title={t('directorStudio.motion.inspector.delete')}
              data-director-tooltip={t('directorStudio.motion.inspector.delete')}
              aria-label={t('directorStudio.motion.inspector.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </UiIconButton>
          </div>
        </>
      )}
    </section>
  );
});

/** Camera aim per keyframe: follow an item, look at a fixed point, or free rotation (spec §4.4 定点跟拍). */
function CameraLookFields({ keyframe, items, onPatch }: {
  keyframe: DirectorCameraKeyframe;
  items: BlueprintItem[];
  onPatch: (patch: Partial<DirectorCameraKeyframe>) => void;
}) {
  const { t } = useTranslation();
  const mode = cameraLookMode(keyframe);
  const distance = Math.max(1, Math.hypot(keyframe.target.x - keyframe.position.x, keyframe.target.y - keyframe.position.y, keyframe.target.z - keyframe.position.z));
  const setMode = (next: CameraLookMode) => {
    if (next === mode) return;
    if (next === 'target') {
      const targetId = keyframe.trackTargetId ?? items[0]?.id;
      if (targetId) onPatch({ trackTargetId: targetId, freeRotation: undefined });
      return;
    }
    if (next === 'point') {
      onPatch({
        trackTargetId: null,
        freeRotation: undefined,
        target: keyframe.freeRotation ? lookPointFromRotation(keyframe.position, keyframe.freeRotation, distance) : keyframe.target,
      });
      return;
    }
    onPatch({ trackTargetId: null, freeRotation: freeRotationFromLook(keyframe.position, keyframe.target) });
  };
  const rotation = keyframe.freeRotation;
  return (
    <div className="space-y-3">
      <div className="text-text-muted">
        <span className="mb-1.5 block">{t('directorStudio.motion.inspector.lookAt')}</span>
        <UiSegmented<CameraLookMode>
          size="sm"
          className="w-full"
          value={mode}
          aria-label={t('directorStudio.motion.inspector.lookAt')}
          onChange={setMode}
          options={[
            { value: 'target', label: t('directorStudio.motion.inspector.lookTarget'), disabled: items.length === 0 },
            { value: 'point', label: t('directorStudio.motion.inspector.lookPoint') },
            { value: 'free', label: t('directorStudio.motion.inspector.lookFree') },
          ]}
        />
      </div>
      {mode === 'target' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0 text-text-muted">
            <span className="mb-1.5 block">{t('directorStudio.motion.inspector.targetMode')}</span>
            <UiSelect
              value={keyframe.trackTargetId ?? ''}
              aria-label={t('directorStudio.motion.inspector.targetMode')}
              onChange={(event) => { if (event.target.value) onPatch({ trackTargetId: event.target.value }); }}
              className={FIELD_CLASS}
            >
              {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </UiSelect>
          </label>
          <label className="block min-w-0 text-text-muted">
            <span className="mb-1.5 block">{t('directorStudio.motion.inspector.targetBodyPart')}</span>
            <UiSelect
              value={keyframe.trackTargetBodyPart ?? 'torso'}
              aria-label={t('directorStudio.motion.inspector.targetBodyPart')}
              onChange={(event) => onPatch({ trackTargetBodyPart: event.target.value })}
              className={FIELD_CLASS}
            >
              {(['head', 'torso', 'feet'] as const).map((part) => (
                <option key={part} value={part}>{t(`directorStudio.motion.inspector.${part}`)}</option>
              ))}
            </UiSelect>
          </label>
        </div>
      ) : mode === 'point' ? (
        <DirectorInspectorVectorFields
          key={`${keyframe.id}:target`}
          label={t('directorStudio.motion.inspector.fixedTarget')}
          value={keyframe.target}
          onCommit={(axis, value) => onPatch({ target: { ...keyframe.target, [axis]: value } })}
        />
      ) : rotation ? (
        <DirectorInspectorVectorFields
          key={`${keyframe.id}:rotation`}
          label={t('directorStudio.motion.inspector.rotationDeg')}
          value={{ x: rotation.x * DEG, y: rotation.y * DEG, z: rotation.z * DEG }}
          step={1}
          suffix="°"
          onCommit={(axis, value) => onPatch({ freeRotation: { ...rotation, [axis]: value / DEG } })}
        />
      ) : null}
      <p className="leading-5 text-text-subtle">{t(`directorStudio.motion.inspector.${mode === 'target' ? 'lookTargetHelp' : mode === 'point' ? 'lookPointHelp' : 'lookFreeHelp'}`)}</p>
    </div>
  );
}
