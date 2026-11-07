import { ArrowLeft, Camera, ChevronRight, DiamondPlus, Film, Route } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import type { BlueprintItem, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import { StageSection } from '@/features/stage/ui/stageKit';
import {
  DirectorMotionInspector,
  getSelectedDirectorKeyframe,
  type DirectorKeyframePatch,
  type DirectorKeyframeSelection,
} from './DirectorMotionInspector';
import { DirectorCameraRigPanel, type CameraRigActions } from './DirectorCameraRigPanel';

interface MotionEditingProps {
  project: DirectorMotionProjectV1;
  items: BlueprintItem[];
  selection: DirectorKeyframeSelection | null;
  onSelectionChange: (selection: DirectorKeyframeSelection | null) => void;
  onTimeChange: (time: number) => void;
  onRetimeTrack: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onPatchKeyframe: (selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => void;
  onDuplicateKeyframe: (selection: DirectorKeyframeSelection) => void;
  onDeleteKeyframe: (selection: DirectorKeyframeSelection) => void;
}

function KeyframeEditor(props: MotionEditingProps & { selectedItemId: string | null }) {
  const keyframe = getSelectedDirectorKeyframe(props.project, props.selection);
  return (
    <DirectorMotionInspector
      project={props.project}
      items={props.items}
      selectedItemId={props.selectedItemId}
      selection={keyframe ? props.selection : null}
      onSelectionChange={props.onSelectionChange}
      onTimeChange={props.onTimeChange}
      onRetimeTrack={props.onRetimeTrack}
      onPatch={props.onPatchKeyframe}
      onDuplicate={props.onDuplicateKeyframe}
      onDelete={props.onDeleteKeyframe}
    />
  );
}

/** Previs inspector for the shot camera: record framing, then edit its keyframes. */
export function DirectorPrevisCameraInspector(props: MotionEditingProps & { onAddCameraKeyframe: () => void; rigActions: CameraRigActions; previewProject: DirectorMotionProjectV1 }) {
  const { t } = useTranslation();
  return (
    <div className="pb-4">
      <div className="flex items-center gap-2.5 px-3.5 pb-3 pt-1">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent"><Camera className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-dark">{t('directorStudio.motion.timeline.camera')}</div>
          <div className="text-[11px] text-text-subtle">{t('directorStudio.motion.inspector.trackSummary', { count: props.project.cameraTrack.length })}</div>
        </div>
      </div>
      <div className="px-3.5 pb-3">
        {!props.project.cameraTrack.length ? <p className="mb-2.5 text-[11px] leading-5 text-text-muted">{t('directorStudio.previs.cameraEmpty')}</p> : null}
        <UiButton variant="accent" size="sm" onClick={props.onAddCameraKeyframe} className="w-full" data-director-tooltip={t('directorStudio.previs.addCameraKeyHelp')}>
          <DiamondPlus className="h-3.5 w-3.5" />{t('directorStudio.previs.addCameraKey')}
        </UiButton>
      </div>
      <DirectorCameraRigPanel project={props.previewProject} items={props.items} actions={props.rigActions} />
      {props.project.cameraTrack.length > 0 ? (
        <StageSection title={t('directorStudio.motion.inspector.title')} icon={<Route className="h-3 w-3" />}>
          <KeyframeEditor {...props} selectedItemId={null} />
        </StageSection>
      ) : null}
    </div>
  );
}

/** Previs "motion" section for one item: its route clip, actions and the selected keyframe. */
export function DirectorPrevisItemMotion(props: MotionEditingProps & {
  item: BlueprintItem;
  onOpenActions: () => void;
}) {
  const { t } = useTranslation();
  const { item, project, selection } = props;
  const objectTrack = project.objectTracks[item.id] ?? [];
  const actionTrack = project.actionTracks[item.id] ?? [];
  const keyframe = getSelectedDirectorKeyframe(project, selection);
  const editingKeyframe = Boolean(keyframe && selection && selection.trackId === item.id);
  const isPerson = item.category === 'person';
  const selectFirst = (kind: 'object' | 'action') => {
    const frame = (kind === 'object' ? objectTrack : actionTrack)[0];
    if (!frame) return;
    props.onSelectionChange({ kind, trackId: item.id, keyframeId: frame.id });
    props.onTimeChange(frame.time);
  };

  return (
    <StageSection
      title={t('directorStudio.inspector.motion')}
      icon={<Route className="h-3 w-3" />}
      trailing={editingKeyframe ? (
        <button type="button" className="stage-chip h-6 px-2 text-[11px]" onClick={() => props.onSelectionChange(null)} data-director-tooltip={t('directorStudio.previs.backToObjectHelp')}>
          <ArrowLeft className="h-3 w-3" />{t('directorStudio.previs.objectProperties')}
        </button>
      ) : undefined}
    >
      {editingKeyframe ? (
        <KeyframeEditor {...props} selectedItemId={item.id} />
      ) : (
        <>
          {objectTrack.length ? (
            <button type="button" onClick={() => selectFirst('object')} className="stage-row w-full bg-[var(--tile-bg)]" data-director-tooltip={t('directorStudio.previs.editRouteHelp')}>
              <Route className="h-3.5 w-3.5 text-accent" />
              <span className="flex-1 text-left">{t('directorStudio.previs.editRoute')}</span>
              <span className="font-mono text-[10px] text-text-subtle">◆ {objectTrack.length}</span>
              <ChevronRight className="h-3.5 w-3.5 text-text-subtle" />
            </button>
          ) : (
            <p className="text-[11px] leading-5 text-text-subtle">{t(isPerson ? 'directorStudio.previs.objectRouteEmpty' : 'directorStudio.previs.propKeyEmpty')}</p>
          )}
          {isPerson ? (
            <>
              {actionTrack.length ? (
                <button type="button" onClick={() => selectFirst('action')} className="stage-row w-full bg-[var(--tile-bg)]" data-director-tooltip={t('directorStudio.previs.editActionsHelp')}>
                  <Film className="h-3.5 w-3.5 text-success" />
                  <span className="flex-1 text-left">{t('directorStudio.previs.editActions')}</span>
                  <span className="font-mono text-[10px] text-text-subtle">◆ {actionTrack.length}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-text-subtle" />
                </button>
              ) : null}
              <UiButton variant="secondary" size="sm" onClick={props.onOpenActions} className="w-full" data-director-tooltip={t('directorStudio.previs.openActionsHelp')}>
                <Film className="h-3.5 w-3.5" />{t('directorStudio.motion.guide.addAction')}
              </UiButton>
            </>
          ) : null}
        </>
      )}
    </StageSection>
  );
}
