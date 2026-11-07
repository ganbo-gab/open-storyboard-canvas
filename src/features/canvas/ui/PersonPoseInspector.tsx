import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlipHorizontal2, RotateCcw, Save, X } from 'lucide-react';

import { UiButton, UiChipButton, UiIconButton, UiInput, UiSlider } from '@/components/ui';
import type { BlueprintActionPose, BlueprintPoseRotation } from '@/features/canvas/domain/canvasNodes';
import {
  PERSON_HAND_SHAPES,
  PERSON_JOINTS,
  PERSON_JOINT_SPECS,
  applyPersonPosePatch,
  copyPersonPoseSide,
  diffPersonPose,
  mirrorPersonPose,
  writePersonFingers,
  writePersonJoint,
  type PersonBodyRegion,
  type PersonPoseAxis,
  type PersonPoseJoint,
} from '@/features/canvas/domain/personPose';
import type { PersonPoseEdit } from './personPoseEditor';

const REGIONS: readonly PersonBodyRegion[] = ['core', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
const HAND_SHAPES = Object.keys(PERSON_HAND_SHAPES) as Array<keyof typeof PERSON_HAND_SHAPES>;
const RAD = Math.PI / 180;

function axisKind(joint: PersonPoseJoint): string {
  if (/Clavicle$/.test(joint)) return 'clavicle';
  if (/UpperArm$|Thigh$/.test(joint)) return 'limb';
  if (/Forearm$/.test(joint)) return 'elbow';
  if (/Shin$/.test(joint)) return 'knee';
  if (/Wrist$/.test(joint)) return 'wrist';
  if (/Foot$/.test(joint)) return 'foot';
  if (/Toes$/.test(joint)) return 'toes';
  return 'core';
}

function readDegrees(pose: BlueprintActionPose, joint: PersonPoseJoint, axis: PersonPoseAxis): number {
  const value = (pose[joint] as BlueprintPoseRotation | undefined)?.[axis];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / RAD) : 0;
}

export interface PersonPoseInspectorProps {
  /** Pose shown in the viewport right now (full, after layering). */
  pose: BlueprintActionPose;
  joint: PersonPoseJoint | null;
  onJointChange: (joint: PersonPoseJoint | null) => void;
  /** Live preview while a slider is held; nothing is stored. */
  onPreview: (pose: BlueprintActionPose) => void;
  onCommit: (edit: PersonPoseEdit) => void;
  /** Drop every edit on the current layer (item pose / keyframe pose). */
  onResetAll: () => void;
  onSaveCustomPose: (name: string, pose: BlueprintActionPose) => void;
  onExit: () => void;
  /** Where edits land, e.g. "人物默认姿态" or "1.20s 关键帧". */
  targetLabel: string;
  defaultPoseName: string;
}

/**
 * Numeric side of pose mode. The viewport handles direct manipulation; this
 * panel offers exact angles within anatomical limits, hand shapes, mirror /
 * copy-side tools and saving the result as a reusable custom pose.
 */
export const PersonPoseInspector = memo(function PersonPoseInspector({
  pose,
  joint,
  onJointChange,
  onPreview,
  onCommit,
  onResetAll,
  onSaveCustomPose,
  onExit,
  targetLabel,
  defaultPoseName,
}: PersonPoseInspectorProps) {
  const { t } = useTranslation();
  // A held slider shows its own draft until release; the viewport previews the same pose.
  const [draft, setDraft] = useState<BlueprintActionPose | null>(null);
  const [poseName, setPoseName] = useState('');
  const shown = draft ?? pose;
  useEffect(() => { setDraft(null); }, [pose]);

  const jointsByRegion = useMemo(
    () => REGIONS.map((region) => ({ region, joints: PERSON_JOINTS.filter((spec) => spec.region === region).map((spec) => spec.key) })),
    [],
  );

  const commit = (next: BlueprintActionPose) => {
    setDraft(null);
    const patch = diffPersonPose(pose, next);
    if (Object.keys(patch).length > 0) onCommit({ patch, pose: next });
  };
  const releaseDraft = () => { if (draft) commit(draft); };

  const spec = joint ? PERSON_JOINT_SPECS[joint] : null;
  const kind = joint ? axisKind(joint) : 'core';

  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-bg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">{t('directorStudio.pose.title')}</div>
          <div className="mt-0.5 truncate text-xs text-text-muted">{targetLabel}</div>
        </div>
        <UiIconButton size="sm" type="button" aria-label={t('directorStudio.pose.exit')} title={t('directorStudio.pose.exit')} onClick={onExit} className="p-1.5">
          <X className="h-3.5 w-3.5" />
        </UiIconButton>
      </div>

      <div className="space-y-1.5">
        {jointsByRegion.map(({ region, joints }) => (
          <div key={region} className="flex items-center gap-1.5">
            <span className="w-11 shrink-0 text-[10px] text-text-subtle">{t(`directorStudio.pose.regions.${region}`)}</span>
            <div className="flex min-w-0 flex-wrap gap-1">
              {joints.map((key) => (
                <UiChipButton key={key} active={joint === key} type="button" onClick={() => onJointChange(key)} className="h-6 px-1.5 text-[10px]">
                  {t(`directorStudio.pose.jointShort.${key.replace(/^(left|right)/, '').replace(/^./, (c) => c.toLowerCase())}`)}
                </UiChipButton>
              ))}
            </div>
          </div>
        ))}
      </div>

      {spec && joint ? (
        <div className="space-y-2 rounded-md border border-[var(--line)] bg-elevated p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-dark">{t(`directorStudio.pose.joints.${joint}`)}</span>
            <UiButton size="sm" variant="ghost" type="button" className="h-6 gap-1 px-1.5 text-[10px]"
              onClick={() => { setDraft(null); onCommit({ patch: { [joint]: null }, pose: applyPersonPosePatch(pose, { [joint]: null }) }); }}>
              <RotateCcw className="h-3 w-3" />{t('directorStudio.pose.resetJoint')}
            </UiButton>
          </div>
          {spec.axes.map((axis) => {
            const [min, max] = spec.limits[axis] ?? [0, 0];
            return (
              <label key={axis} className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t(`directorStudio.pose.axes.${kind}.${axis}`)}</span>
                <UiSlider
                  value={readDegrees(shown, joint, axis)}
                  min={min}
                  max={max}
                  step={1}
                  format={(value) => `${value}°`}
                  aria-label={`${t(`directorStudio.pose.joints.${joint}`)} ${t(`directorStudio.pose.axes.${kind}.${axis}`)}`}
                  onChange={(degrees) => {
                    const next = writePersonJoint(shown, joint, axis, degrees * RAD);
                    setDraft(next);
                    onPreview(next);
                  }}
                  onPointerUp={releaseDraft}
                  onKeyUp={releaseDraft}
                  onBlur={releaseDraft}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--line)] px-2.5 py-2 text-[11px] leading-5 text-text-subtle">{t('directorStudio.pose.noJoint')}</div>
      )}

      <div className="space-y-1.5">
        <div className="text-[10px] text-text-subtle">{t('directorStudio.pose.hands')}</div>
        {(['left', 'right'] as const).map((side) => (
          <div key={side} className="flex items-center gap-1.5">
            <span className="w-11 shrink-0 text-[10px] text-text-muted">{t(`directorStudio.pose.hand.${side}`)}</span>
            <div className="flex flex-wrap gap-1">
              {HAND_SHAPES.map((shape) => (
                <UiChipButton key={shape} type="button" className="h-6 px-1.5 text-[10px]"
                  active={JSON.stringify(shown[`${side}Fingers`] ?? null) === JSON.stringify(PERSON_HAND_SHAPES[shape])}
                  onClick={() => commit(writePersonFingers(shown, `${side}Fingers`, PERSON_HAND_SHAPES[shape]))}>
                  {t(`directorStudio.pose.handShapes.${shape}`)}
                </UiChipButton>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <UiButton size="sm" type="button" className="h-8 gap-1 text-[11px]" onClick={() => commit(mirrorPersonPose(shown))}>
          <FlipHorizontal2 className="h-3.5 w-3.5" />{t('directorStudio.pose.mirror')}
        </UiButton>
        <UiButton size="sm" type="button" className="h-8 gap-1 text-[11px]" onClick={() => { setDraft(null); onResetAll(); }}>
          <RotateCcw className="h-3.5 w-3.5" />{t('directorStudio.pose.resetAll')}
        </UiButton>
        <UiButton size="sm" type="button" className="h-8 text-[11px]" onClick={() => commit(copyPersonPoseSide(shown, 'left', 'arm'))}>{t('directorStudio.pose.copyArmLeftToRight')}</UiButton>
        <UiButton size="sm" type="button" className="h-8 text-[11px]" onClick={() => commit(copyPersonPoseSide(shown, 'right', 'arm'))}>{t('directorStudio.pose.copyArmRightToLeft')}</UiButton>
        <UiButton size="sm" type="button" className="h-8 text-[11px]" onClick={() => commit(copyPersonPoseSide(shown, 'left', 'leg'))}>{t('directorStudio.pose.copyLegLeftToRight')}</UiButton>
        <UiButton size="sm" type="button" className="h-8 text-[11px]" onClick={() => commit(copyPersonPoseSide(shown, 'right', 'leg'))}>{t('directorStudio.pose.copyLegRightToLeft')}</UiButton>
      </div>

      <div className="flex items-center gap-1.5">
        <UiInput value={poseName} onChange={(event) => setPoseName(event.target.value)} placeholder={t('directorStudio.pose.savePlaceholder')}
          className="h-8 min-w-0 flex-1 px-2 text-xs placeholder:text-text-subtle" />
        <UiButton size="sm" variant="secondary" type="button" className="h-8 shrink-0 gap-1 px-2 text-[11px]"
          onClick={() => { onSaveCustomPose(poseName.trim() || defaultPoseName, shown); setPoseName(''); }}>
          <Save className="h-3.5 w-3.5" />{t('directorStudio.pose.save')}
        </UiButton>
      </div>
    </div>
  );
});
