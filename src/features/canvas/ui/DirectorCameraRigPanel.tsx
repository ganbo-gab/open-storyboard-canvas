import { useState } from 'react';
import { Focus, Footprints, Lock, Trash2, Wand2, Copy, Scissors, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiSegmented, UiSelect, UiSlider, UiSwitch } from '@/components/ui';
import {
  DIRECTOR_CAMERA_RIG_LIMITS,
  DIRECTOR_CAMERA_RIG_MIN_SECONDS,
} from '@/features/canvas/application/directorMotion';
import type {
  BlueprintItem,
  DirectorCameraRig,
  DirectorCameraRigBodyPart,
  DirectorCameraRigKind,
  DirectorMotionProjectV1,
} from '@/features/canvas/domain/canvasNodes';
import { ScrubNumber, StageSection } from '@/features/stage/ui/stageKit';
import { focalLengthFromFov } from '@/features/canvas/domain/cameraLens';

export interface CameraRigActions {
  onAddRig: (kind: DirectorCameraRigKind, itemId: string) => string | null;
  /** Streams while a control is dragged; nothing is committed. */
  onPreviewRig: (rigId: string, patch: Partial<DirectorCameraRig>) => void;
  /** One committed edit (one undo step). */
  onUpdateRig: (rigId: string, patch: Partial<DirectorCameraRig>) => void;
  onDeleteRig: (rigId: string) => void;
  onBakeRig: (rigId: string) => void;
  onTimeChange: (time: number) => void;
  onEditSegment?: (rigId: string, operation: 'split' | 'duplicate' | 'front') => void;
}

type NumericRigKey = keyof typeof DIRECTOR_CAMERA_RIG_LIMITS;

const RIG_FIELDS: ReadonlyArray<{ key: NumericRigKey; labelKey: string; step: number; suffix: string }> = [
  { key: 'distance', labelKey: 'distance', step: 0.05, suffix: 'm' },
  { key: 'height', labelKey: 'height', step: 0.05, suffix: 'm' },
  { key: 'azimuthDeg', labelKey: 'azimuth', step: 1, suffix: '°' },
  { key: 'pitchDeg', labelKey: 'pitch', step: 1, suffix: '°' },
  { key: 'fov', labelKey: 'fov', step: 0.5, suffix: '°' },
  { key: 'damping', labelKey: 'damping', step: 0.01, suffix: '' },
];

/**
 * Slider that previews every movement and commits once when released (pointer, keyboard or blur).
 * Keeps a local value so the thumb tracks the pointer without waiting for the store. `value` already
 * reflects the preview, so release always reports; the owner drops no-op commits and clears the draft.
 */
function RigSlider({ label, value, min, max, step, suffix, onPreview, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  const commit = () => {
    if (live === null) return;
    setLive(null);
    onCommit(live);
  };
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_68px] items-center gap-2">
      <span className="truncate text-[11px] text-text-muted">{label}</span>
      <UiSlider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(next) => { setLive(next); onPreview(next); }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="min-w-0"
      />
      <ScrubNumber label="↔" ariaLabel={label} value={shown} min={min} max={max} step={step} suffix={suffix || undefined} onChange={onPreview} onCommit={onCommit} />
    </div>
  );
}

/** Previs camera: live follow / close-up rigs on a subject (spec 05 §4.5, tutorial 相对位置跟随 / 特写跟踪). */
export function DirectorCameraRigPanel({ project, items, actions }: {
  project: DirectorMotionProjectV1;
  items: BlueprintItem[];
  actions: CameraRigActions;
}) {
  const { t } = useTranslation();
  const subjects = items.filter((item) => item.category !== 'scene');
  const [subjectId, setSubjectId] = useState<string>('');
  const [openRigId, setOpenRigId] = useState<string | null>(null);
  const subject = subjects.find((item) => item.id === subjectId) ?? subjects.find((item) => item.category === 'person') ?? subjects[0];
  const label = (key: string) => t(`directorStudio.previs.rig.${key}`);
  const add = (kind: DirectorCameraRigKind) => {
    if (!subject) return;
    const id = actions.onAddRig(kind, subject.id);
    if (id) setOpenRigId(id);
  };

  return (
    <StageSection title={label('title')} icon={<Focus className="h-3 w-3" />}>
      <p className="text-[11px] leading-5 text-text-subtle">{label('help')}</p>
      {subjects.length ? (
        <>
          <UiSelect
            value={subject?.id ?? ''}
            aria-label={label('subject')}
            onChange={(event) => setSubjectId(event.target.value)}
            className="h-8 w-full px-2 text-xs"
          >
            {subjects.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </UiSelect>
          <div className="grid grid-cols-2 gap-1.5">
            <UiButton variant="secondary" size="sm" onClick={() => add('follow')} data-director-tooltip={label('followHelp')}>
              <Footprints className="h-3.5 w-3.5" />{label('addFollow')}
            </UiButton>
            <UiButton variant="secondary" size="sm" onClick={() => add('closeup')} data-director-tooltip={label('closeupHelp')}>
              <Focus className="h-3.5 w-3.5" />{label('addCloseup')}
            </UiButton>
          </div>
        </>
      ) : (
        <p className="text-[11px] leading-5 text-text-muted">{label('noSubjects')}</p>
      )}
      {project.cameraRigs.map((rig) => {
        const target = items.find((item) => item.id === rig.targetId);
        const open = openRigId === rig.id;
        const preview = (patch: Partial<DirectorCameraRig>) => actions.onPreviewRig(rig.id, patch);
        const update = (patch: Partial<DirectorCameraRig>) => actions.onUpdateRig(rig.id, patch);
        return (
          <div key={rig.id} className="rounded-xl bg-[var(--tile-bg)] shadow-[inset_0_0_0_1px_var(--line)]">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
              aria-expanded={open}
              onClick={() => { setOpenRigId(open ? null : rig.id); if (!open) actions.onTimeChange(rig.start); }}
            >
              {rig.kind === 'closeup' ? <Focus className="h-3.5 w-3.5 text-accent" /> : <Footprints className="h-3.5 w-3.5 text-accent" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-text-dark">
                  {label(rig.kind === 'closeup' ? 'closeup' : 'follow')} · {target?.label ?? label('missingSubject')}
                </span>
                <span className="block font-mono text-[10px] text-text-subtle">
                  {rig.start.toFixed(1)}–{rig.end.toFixed(1)}s · {Math.round(focalLengthFromFov(rig.fov))}mm
                </span>
              </span>
            </button>
            {open ? (
              <div className="space-y-2.5 border-t border-[var(--line)] px-2.5 pb-2.5 pt-2.5">
                {actions.onEditSegment ? <div className="flex flex-wrap gap-1">
                  <UiButton size="sm" variant="ghost" onClick={() => actions.onEditSegment?.(rig.id, 'split')}><Scissors className="h-3.5 w-3.5" />{t('ui.stage.rig.split')}</UiButton>
                  <UiButton size="sm" variant="ghost" onClick={() => actions.onEditSegment?.(rig.id, 'duplicate')}><Copy className="h-3.5 w-3.5" />{t('ui.stage.rig.duplicate')}</UiButton>
                  <UiButton size="sm" variant="ghost" onClick={() => actions.onEditSegment?.(rig.id, 'front')}><Layers className="h-3.5 w-3.5" />{t('ui.stage.rig.front')}</UiButton>
                  <span className="px-2 text-xs text-text-subtle">{t('ui.stage.rig.priority')} {rig.priority ?? 0}</span>
                </div> : null}
                <div className="grid grid-cols-2 gap-1.5">
                  <ScrubNumber
                    label={label('start')}
                    value={rig.start}
                    min={0}
                    max={rig.end - DIRECTOR_CAMERA_RIG_MIN_SECONDS}
                    step={0.1}
                    suffix="s"
                    onCommit={(start) => { update({ start }); actions.onTimeChange(start); }}
                  />
                  <ScrubNumber
                    label={label('end')}
                    value={rig.end}
                    min={rig.start + DIRECTOR_CAMERA_RIG_MIN_SECONDS}
                    max={project.durationSeconds}
                    step={0.1}
                    suffix="s"
                    onCommit={(end) => update({ end })}
                  />
                </div>
                <UiSegmented<DirectorCameraRigBodyPart>
                  size="sm"
                  className="w-full"
                  value={rig.bodyPart}
                  aria-label={label('bodyPart')}
                  onChange={(bodyPart) => update({ bodyPart })}
                  options={(['head', 'torso', 'feet'] as const).map((part) => ({ value: part, label: t(`directorStudio.motion.inspector.${part}`) }))}
                />
                {RIG_FIELDS.map((field) => {
                  const [min, max] = DIRECTOR_CAMERA_RIG_LIMITS[field.key];
                  return (
                    <RigSlider
                      key={field.key}
                      label={label(field.labelKey)}
                      value={rig[field.key]}
                      min={min}
                      max={max}
                      step={field.step}
                      suffix={field.suffix}
                      onPreview={(value) => preview({ [field.key]: value })}
                      onCommit={(value) => update({ [field.key]: value })}
                    />
                  );
                })}
                <label className="flex items-center justify-between gap-3 text-[11px] text-text-muted" data-director-tooltip={label('relativeHelp')}>
                  <span>{label('relative')}</span>
                  <UiSwitch checked={rig.relative} onCheckedChange={(relative) => update({ relative })} aria-label={label('relative')} />
                </label>
                <label className="flex items-center justify-between gap-3 text-[11px] text-text-muted" data-director-tooltip={label('lockHorizonHelp')}>
                  <span className="flex items-center gap-1.5"><Lock className="h-3 w-3" />{label('lockHorizon')}</span>
                  <UiSwitch checked={rig.lockHorizon} onCheckedChange={(lockHorizon) => update({ lockHorizon })} aria-label={label('lockHorizon')} />
                </label>
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <UiButton variant="secondary" size="sm" onClick={() => actions.onBakeRig(rig.id)} data-director-tooltip={label('bakeHelp')}>
                    <Wand2 className="h-3.5 w-3.5" />{label('bake')}
                  </UiButton>
                  <UiButton variant="ghost" size="sm" onClick={() => actions.onDeleteRig(rig.id)}>
                    <Trash2 className="h-3.5 w-3.5" />{label('delete')}
                  </UiButton>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </StageSection>
  );
}
