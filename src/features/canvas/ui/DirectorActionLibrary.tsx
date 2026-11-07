import { memo, useMemo, useState } from 'react';
import { Copy, Film, Pencil, Play, RotateCcw, Trash2, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiInput, UiTabs } from '@/components/ui';

import { PERSON_ACTIONS, PERSON_POSES } from '@/features/canvas/application/personMotionLibrary';
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
  const [tab, setTab] = useState<LibraryTab>('actions');
  const [clipName, setClipName] = useState('');
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [editingClipName, setEditingClipName] = useState('');
  const customPoseEntries = useMemo(() => Object.entries(customActionPoses), [customActionPoses]);

  if (!isOpen) return null;
  const personSelected = selectedItem?.category === 'person';

  return (
    <div
      className="absolute inset-0 z-75 flex items-center justify-center bg-[var(--scrim)] p-5 backdrop-blur-xs"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <section className="flex max-h-[78vh] w-[760px] max-w-full flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-accent" />
            <div className="text-sm font-medium text-text-dark">{t('directorStudio.motion.library.title')}</div>
            {selectedItem ? <span className="max-w-[230px] truncate text-[10px] text-text-subtle">{selectedItem.label}</span> : null}
          </div>
          <UiIconButton size="sm" type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-sm" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </UiIconButton>
        </header>
        <UiTabs<LibraryTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'poses', label: t('directorStudio.motion.library.poses') },
            { value: 'actions', label: t('directorStudio.motion.library.actions') },
            { value: 'clips', label: t('directorStudio.motion.library.clips') },
          ]}
          className="shrink-0 px-3 pt-2"
        />
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {!personSelected ? (
            <div className="mb-3 rounded-sm border border-warning/15 bg-warning/8 px-3 py-2 text-[11px] text-warning">
              {t('directorStudio.motion.library.selectPerson')}
            </div>
          ) : null}

          {tab === 'poses' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PERSON_POSES.map((pose) => (
                <UiButton variant="secondary" size="sm"
                  key={pose.id}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyStaticPose(pose.id, pose.pose)}
                  className="flex h-auto min-h-[58px] flex-col items-start justify-between rounded-sm px-2.5 py-2 text-left text-[10px]"
                >
                  <span className="text-xs text-text-dark">{t(pose.labelKey)}</span>
                </UiButton>
              ))}
              {customPoseEntries.map(([name, pose]) => (
                <UiButton variant="secondary" size="sm"
                  key={`custom:${name}`}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyStaticPose(name, pose)}
                  className="flex h-auto min-h-[58px] flex-col items-start justify-between rounded-sm px-2.5 py-2 text-left text-[10px]"
                >
                  <span className="truncate text-[11px]">{name}</span>
                  <span className="font-mono text-[9px] text-warning">{t('directorStudio.motion.library.custom')}</span>
                </UiButton>
              ))}
            </div>
          ) : null}

          {tab === 'actions' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PERSON_ACTIONS.map((action) => (
                <UiButton variant="secondary" size="sm"
                  key={action.id}
                  type="button"
                  disabled={!personSelected}
                  onClick={() => onApplyProceduralAction(action.id)}
                  className="flex h-auto min-h-[72px] flex-col items-start justify-between rounded-sm px-3 py-2 text-left"
                >
                  <span className="flex items-center gap-2 text-xs text-text-dark"><Play className="h-3.5 w-3.5 text-accent" />{t(action.labelKey)}</span>
                  <span className="font-mono text-[11px] text-text-muted">{action.durationSeconds.toFixed(2)}s</span>
                </UiButton>
              ))}
            </div>
          ) : null}

          {tab === 'clips' ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <UiInput
                  value={clipName}
                  onChange={(event) => setClipName(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  placeholder={t('directorStudio.motion.library.clipNamePlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded-sm px-2.5 text-xs"
                />
                <UiButton variant="primary" size="sm"
                  type="button"
                  onClick={() => { onSaveClip(clipName); setClipName(''); }}
                  disabled={!selectedItem || selectedItem.category !== 'person' || !project.actionTracks[selectedItem.id]?.length}
                  className="inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-xs"
                ><Film className="h-3.5 w-3.5" />{t('directorStudio.motion.library.saveClip')}</UiButton>
              </div>
              {project.customClips.length === 0 ? (
                <div className="rounded-sm border border-dashed border-[var(--line)] px-3 py-8 text-center text-xs text-text-subtle">{t('directorStudio.motion.library.noClips')}</div>
              ) : null}
              {project.customClips.map((clip) => (
                <div key={clip.id} className="flex items-center gap-2 rounded-sm border border-[var(--line)] bg-[var(--hover)] px-3 py-2">
                  {editingClipId === clip.id ? (
                    <UiInput
                      autoFocus
                      value={editingClipName}
                      onChange={(event) => setEditingClipName(event.target.value)}
                      onBlur={() => { onRenameClip(clip.id, editingClipName); setEditingClipId(null); }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') { onRenameClip(clip.id, editingClipName); setEditingClipId(null); }
                        if (event.key === 'Escape') setEditingClipId(null);
                      }}
                      className="h-7 min-w-0 flex-1 rounded-sm px-2 text-xs"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-text-dark">{clip.name}</div>
                      <div className="font-mono text-[9px] text-text-subtle">{clip.durationSeconds.toFixed(2)}s · {clip.keyframes.length} {t('directorStudio.motion.library.keyframes')}</div>
                    </div>
                  )}
                  <UiIconButton size="sm" type="button" onClick={() => onApplyClip(clip)} disabled={!personSelected} className="flex h-7 w-7 items-center justify-center rounded-sm" title={t('directorStudio.motion.library.apply')} aria-label={t('directorStudio.motion.library.apply')}><Play className="h-3.5 w-3.5" /></UiIconButton>
                  <UiIconButton size="sm" type="button" onClick={() => { setEditingClipId(clip.id); setEditingClipName(clip.name); }} className="flex h-7 w-7 items-center justify-center rounded-sm" title={t('directorStudio.motion.library.rename')} aria-label={t('directorStudio.motion.library.rename')}><Pencil className="h-3.5 w-3.5" /></UiIconButton>
                  <UiIconButton size="sm" type="button" onClick={() => onDuplicateClip(clip.id)} className="flex h-7 w-7 items-center justify-center rounded-sm" title={t('directorStudio.motion.library.duplicate')} aria-label={t('directorStudio.motion.library.duplicate')}><Copy className="h-3.5 w-3.5" /></UiIconButton>
                  <UiIconButton size="sm" type="button" active={clip.loop} onClick={() => onLoopClip(clip.id, !clip.loop)} className="flex h-7 w-7 items-center justify-center rounded-sm" title={t('directorStudio.motion.library.loop')} aria-label={t('directorStudio.motion.library.loop')} aria-pressed={clip.loop}><RotateCcw className="h-3.5 w-3.5" /></UiIconButton>
                  <UiIconButton size="sm" type="button" onClick={() => onDeleteClip(clip.id)} className="text-danger hover:text-danger flex h-7 w-7 items-center justify-center rounded-sm" title={t('directorStudio.motion.library.delete')} aria-label={t('directorStudio.motion.library.delete')}><Trash2 className="h-3.5 w-3.5" /></UiIconButton>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-4 py-2 text-[10px] text-text-subtle">
          <span>{t('directorStudio.motion.library.timeAt', { time: currentTime.toFixed(2) })}</span>
          <UiButton variant="secondary" size="sm" type="button" onClick={onClose} className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-xs"><X className="h-3.5 w-3.5" />{t('common.close')}</UiButton>
        </footer>
      </section>
    </div>
  );
});
