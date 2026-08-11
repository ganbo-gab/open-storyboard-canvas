import { memo } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  DirectorActionKeyframe,
  DirectorCameraKeyframe,
  DirectorMotionProjectV1,
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
  selection: DirectorKeyframeSelection | null;
  onPatch: (selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => void;
  onDuplicate: (selection: DirectorKeyframeSelection) => void;
  onDelete: (selection: DirectorKeyframeSelection) => void;
};

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
  selection,
  onPatch,
  onDuplicate,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const keyframe = getSelectedDirectorKeyframe(project, selection);

  return (
    <aside className="hidden w-[180px] shrink-0 border-l border-white/10 bg-[#0d1113] p-3 md:block lg:w-[218px]">
      <div className="mb-3 text-[11px] font-medium text-white/72">
        {t('directorStudio.motion.inspector.title')}
      </div>
      {!selection || !keyframe ? (
        <div className="text-[10px] leading-4 text-white/38">
          {t('directorStudio.motion.inspector.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-[10px] text-white/52">
            <span className="mb-1 block">{t('directorStudio.motion.inspector.time')}</span>
            <input
              type="number"
              min={0}
              max={project.durationSeconds}
              step={0.05}
              value={Number(keyframe.time.toFixed(3))}
              onChange={(event) => onPatch(selection, {
                time: Math.min(project.durationSeconds, Math.max(0, Number(event.target.value) || 0)),
              })}
              className="h-8 w-full rounded border border-white/12 bg-black/25 px-2 font-mono text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
            />
          </label>
          <label className="block text-[10px] text-white/52">
            <span className="mb-1 block">{t('directorStudio.motion.inspector.easing')}</span>
            <select
              value={keyframe.easing}
              onChange={(event) => onPatch(selection, { easing: event.target.value === 'smooth' ? 'smooth' : 'linear' })}
              className="h-8 w-full rounded border border-white/12 bg-[#111719] px-2 text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
            >
              <option value="linear">{t('directorStudio.motion.inspector.linear')}</option>
              <option value="smooth">{t('directorStudio.motion.inspector.smooth')}</option>
            </select>
          </label>
          {selection.kind === 'camera' && 'fov' in keyframe ? (
            <label className="block text-[10px] text-white/52">
              <span className="mb-1 flex justify-between">
                <span>{t('directorStudio.motion.inspector.fov')}</span>
                <span className="font-mono text-white/72">{keyframe.fov.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={10}
                max={150}
                step={0.1}
                value={keyframe.fov}
                onChange={(event) => onPatch(selection, { fov: Number(event.target.value) })}
                className="w-full accent-white"
              />
            </label>
          ) : null}
          {selection.kind === 'object' && 'orientToPath' in keyframe ? (
            <label className="flex items-center justify-between gap-2 text-[10px] text-white/58">
              <span>{t('directorStudio.motion.inspector.orientToPath')}</span>
              <input
                type="checkbox"
                checked={keyframe.orientToPath === true}
                onChange={(event) => onPatch(selection, { orientToPath: event.target.checked })}
                className="h-4 w-4 accent-white"
              />
            </label>
          ) : null}
          <div className="flex gap-2 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => onDuplicate(selection)}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded border border-white/12 bg-white/6 text-[10px] text-white/66 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60"
            >
              <Copy className="h-3.5 w-3.5" />
              {t('directorStudio.motion.inspector.duplicate')}
            </button>
            <button
              type="button"
              onClick={() => onDelete(selection)}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-red-300/20 bg-red-500/10 text-red-100 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-300/50"
              title={t('directorStudio.motion.inspector.delete')}
              aria-label={t('directorStudio.motion.inspector.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
});
