import { memo, useMemo, useState } from 'react';
import { Copy, Film, Pencil, Play, RotateCcw, Trash2, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DIRECTOR_PROCEDURAL_ACTIONS,
  DIRECTOR_STATIC_POSES,
} from '@/features/canvas/application/directorMotion';
import type { BlueprintActionPose, BlueprintItem, DirectorActionClip, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';

type Props = {
  isOpen: boolean;
  selectedItem: BlueprintItem | null;
  project: DirectorMotionProjectV1;
  currentTime: number;
  customActionPoses: Record<string, BlueprintActionPose>;
  onClose: () => void;
  onApplyStaticPose: (poseId: string, pose: BlueprintActionPose) => void;
  onApplyProceduralAction: (actionId: string) => void;
  onApplyClip: (clip: DirectorActionClip) => void;
  onSaveClip: (name: string) => void;
  onRenameClip: (clipId: string, name: string) => void;
  onDuplicateClip: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onLoopClip: (clipId: string, loop: boolean) => void;
};

type LibraryTab = 'poses' | 'actions' | 'clips';

export const DirectorActionLibrary = memo(function DirectorActionLibrary({
  isOpen,
  selectedItem,
  project,
  currentTime,
  customActionPoses,
  onClose,
  onApplyStaticPose,
  onApplyProceduralAction,
  onApplyClip,
  onSaveClip,
  onRenameClip,
  onDuplicateClip,
  onDeleteClip,
  onLoopClip,
}: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<LibraryTab>('poses');
  const [clipName, setClipName] = useState('');
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [editingClipName, setEditingClipName] = useState('');
  const customPoseEntries = useMemo(() => Object.entries(customActionPoses), [customActionPoses]);

  if (!isOpen) return null;
  const personSelected = selectedItem?.category === 'person';

  return (
    <div
      className="absolute inset-0 z-[75] flex items-center justify-center bg-black/58 p-5 backdrop-blur-sm"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <section className="flex max-h-[78vh] w-[760px] max-w-full flex-col overflow-hidden rounded-lg border border-white/12 bg-[#111719] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-accent" />
            <div className="text-sm font-medium text-white/88">{t('directorStudio.motion.library.title')}</div>
            {selectedItem ? <span className="max-w-[230px] truncate text-[10px] text-white/36">{selectedItem.label}</span> : null}
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded text-white/48 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex shrink-0 border-b border-white/10 px-3 pt-2">
          {([
            ['poses', t('directorStudio.motion.library.poses')],
            ['actions', t('directorStudio.motion.library.actions')],
            ['clips', t('directorStudio.motion.library.clips')],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`border-b-2 px-3 py-2 text-xs ${tab === value ? 'border-accent text-white' : 'border-transparent text-white/48 hover:text-white/80'}`}
            >{label}</button>
          ))}
        </div>
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {!personSelected ? (
            <div className="mb-3 rounded border border-amber-200/15 bg-amber-300/8 px-3 py-2 text-[11px] text-amber-100/75">
              {t('directorStudio.motion.library.selectPerson')}
            </div>
          ) : null}

          {tab === 'poses' ? (
            <div className="grid grid-cols-4 gap-2">
              {DIRECTOR_STATIC_POSES.map((pose) => (
                <button
                  key={pose.id}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyStaticPose(pose.id, pose.pose)}
                  className="flex min-h-[58px] flex-col items-start justify-between rounded border border-white/10 bg-white/5 px-2.5 py-2 text-left text-[10px] text-white/68 hover:border-accent/60 hover:bg-accent/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-accent/60"
                >
                  <span className="text-[11px] text-white/84">{t(pose.labelKey)}</span>
                  <span className="font-mono text-[9px] text-white/32">{pose.id}</span>
                </button>
              ))}
              {customPoseEntries.map(([name, pose]) => (
                <button
                  key={`custom:${name}`}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyStaticPose(name, pose)}
                  className="flex min-h-[58px] flex-col items-start justify-between rounded border border-amber-200/20 bg-amber-300/8 px-2.5 py-2 text-left text-[10px] text-amber-100/75 hover:border-amber-200/50 hover:bg-amber-300/14 hover:text-amber-50 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-amber-200/60"
                >
                  <span className="truncate text-[11px]">{name}</span>
                  <span className="font-mono text-[9px] text-amber-100/32">{t('directorStudio.motion.library.custom')}</span>
                </button>
              ))}
            </div>
          ) : null}

          {tab === 'actions' ? (
            <div className="grid grid-cols-3 gap-2">
              {DIRECTOR_PROCEDURAL_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyProceduralAction(action.id)}
                  className="flex min-h-[72px] flex-col items-start justify-between rounded border border-sky-200/15 bg-sky-300/8 px-3 py-2 text-left text-white/78 hover:border-sky-200/45 hover:bg-sky-300/14 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-sky-200/60"
                >
                  <span className="flex items-center gap-2 text-xs text-white/88"><Play className="h-3.5 w-3.5 text-sky-200" />{t(action.labelKey)}</span>
                  <span className="font-mono text-[9px] text-white/36">{action.durationSeconds.toFixed(2)}s</span>
                </button>
              ))}
            </div>
          ) : null}

          {tab === 'clips' ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  value={clipName}
                  onChange={(event) => setClipName(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  placeholder={t('directorStudio.motion.library.clipNamePlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded border border-white/12 bg-black/25 px-2.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
                />
                <button
                  type="button"
                  onClick={() => { onSaveClip(clipName); setClipName(''); }}
                  disabled={!selectedItem || selectedItem.category !== 'person' || !project.actionTracks[selectedItem.id]?.length}
                  className="inline-flex h-9 items-center gap-1.5 rounded bg-white px-3 text-xs text-black hover:bg-white/88 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-accent/70"
                ><Film className="h-3.5 w-3.5" />{t('directorStudio.motion.library.saveClip')}</button>
              </div>
              {project.customClips.length === 0 ? (
                <div className="rounded border border-dashed border-white/12 px-3 py-8 text-center text-xs text-white/38">{t('directorStudio.motion.library.noClips')}</div>
              ) : null}
              {project.customClips.map((clip) => (
                <div key={clip.id} className="flex items-center gap-2 rounded border border-white/10 bg-white/5 px-3 py-2">
                  {editingClipId === clip.id ? (
                    <input
                      autoFocus
                      value={editingClipName}
                      onChange={(event) => setEditingClipName(event.target.value)}
                      onBlur={() => { onRenameClip(clip.id, editingClipName); setEditingClipId(null); }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') { onRenameClip(clip.id, editingClipName); setEditingClipId(null); }
                        if (event.key === 'Escape') setEditingClipId(null);
                      }}
                      className="h-7 min-w-0 flex-1 rounded border border-accent/50 bg-black/25 px-2 text-xs text-white outline-none"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-white/84">{clip.name}</div>
                      <div className="font-mono text-[9px] text-white/38">{clip.durationSeconds.toFixed(2)}s · {clip.keyframes.length} {t('directorStudio.motion.library.keyframes')}</div>
                    </div>
                  )}
                  <button type="button" onClick={() => onApplyClip(clip)} disabled={!personSelected} className="flex h-7 w-7 items-center justify-center rounded text-sky-200/75 hover:bg-sky-300/12 hover:text-sky-100 disabled:opacity-35" title={t('directorStudio.motion.library.apply')} aria-label={t('directorStudio.motion.library.apply')}><Play className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => { setEditingClipId(clip.id); setEditingClipName(clip.name); }} className="flex h-7 w-7 items-center justify-center rounded text-white/42 hover:bg-white/10 hover:text-white" title={t('directorStudio.motion.library.rename')} aria-label={t('directorStudio.motion.library.rename')}><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onDuplicateClip(clip.id)} className="flex h-7 w-7 items-center justify-center rounded text-white/42 hover:bg-white/10 hover:text-white" title={t('directorStudio.motion.library.duplicate')} aria-label={t('directorStudio.motion.library.duplicate')}><Copy className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onLoopClip(clip.id, !clip.loop)} className={`flex h-7 w-7 items-center justify-center rounded ${clip.loop ? 'bg-accent/18 text-accent' : 'text-white/42 hover:bg-white/10 hover:text-white'}`} title={t('directorStudio.motion.library.loop')} aria-label={t('directorStudio.motion.library.loop')} aria-pressed={clip.loop}><RotateCcw className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onDeleteClip(clip.id)} className="flex h-7 w-7 items-center justify-center rounded text-red-200/55 hover:bg-red-500/12 hover:text-red-100" title={t('directorStudio.motion.library.delete')} aria-label={t('directorStudio.motion.library.delete')}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-white/10 px-4 py-2 text-[10px] text-white/38">
          <span>{t('directorStudio.motion.library.timeAt', { time: currentTime.toFixed(2) })}</span>
          <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-1.5 rounded border border-white/10 bg-white/6 px-3 text-xs text-white/62 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60"><X className="h-3.5 w-3.5" />{t('common.close')}</button>
        </footer>
      </section>
    </div>
  );
});
