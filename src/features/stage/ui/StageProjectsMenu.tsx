import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ImageOff, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiIconButton } from '@/components/ui';

export interface StageProjectSummary {
  id: string;
  name: string;
  coverUrl: string | null;
  updatedAt: number;
}

/** Saved stage projects: open, rename (double-click), recapture cover, delete, start blank. */
export function StageProjectsMenu({ projects, activeId, formatTime, onOpen, onRename, onCover, onDelete, onCreate, onClose }: {
  projects: StageProjectSummary[];
  activeId: string | null;
  formatTime: (value: number) => string;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onCover: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      // The trigger toggles on its own; everything else outside closes the menu.
      if (event.target instanceof Element && event.target.closest('[aria-haspopup="dialog"]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || editing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editing, onClose]);

  const commit = () => {
    if (!editing) return;
    onRename(editing.id, editing.name);
    setEditing(null);
  };

  return (
    <div ref={rootRef} role="dialog" data-stage-popover aria-label={t('directorStudio.projects')} className="stage-glass stage-pop absolute left-0 top-[calc(100%+8px)] z-[60] flex max-h-[min(560px,calc(100vh-90px))] w-[360px] flex-col overflow-hidden rounded-2xl">
      <header className="flex items-center justify-between px-4 pb-2 pt-3">
        <div>
          <h3 className="text-[13px] font-semibold text-text-dark">{t('directorStudio.projects')}</h3>
          <p className="mt-0.5 text-[11px] text-text-subtle">{t('directorStudio.projectsHint')}</p>
        </div>
        <button type="button" onClick={onCreate} className="stage-chip text-text-dark" data-director-tooltip={t('directorStudio.newProject')}>
          <Plus className="h-3.5 w-3.5" />{t('directorStudio.newProjectShort')}
        </button>
      </header>
      <div className="ui-scrollbar grid min-h-0 grid-cols-2 gap-2.5 overflow-y-auto px-3 pb-3">
        {projects.length === 0 ? (
          <p className="col-span-2 rounded-xl border border-dashed border-[var(--line-strong)] px-4 py-8 text-center text-xs leading-5 text-text-subtle">{t('directorStudio.noProjects')}</p>
        ) : null}
        {projects.map((project) => {
          const active = project.id === activeId;
          return (
            <div key={project.id} className={`group relative overflow-hidden rounded-xl bg-[var(--tile-bg)] transition-[box-shadow,background-color] hover:bg-[var(--tile-bg-hover)] ${active ? 'shadow-[0_0_0_1.5px_rgb(var(--accent-rgb))]' : 'shadow-[0_0_0_1px_var(--line)]'}`}>
              <button type="button" onClick={() => onOpen(project.id)} className="block w-full text-left" aria-label={t('directorStudio.openProjectNamed', { name: project.name })}>
                <div className="relative aspect-video overflow-hidden bg-[var(--media-placeholder)]">
                  {project.coverUrl ? (
                    <img src={project.coverUrl} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" draggable={false} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-text-subtle"><ImageOff className="h-5 w-5" /></div>
                  )}
                  {active ? <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-fg)]"><Check className="h-3 w-3" />{t('directorStudio.currentProject')}</span> : null}
                </div>
              </button>
              <div className="px-2 pb-2 pt-1.5">
                {editing?.id === project.id ? (
                  <input
                    autoFocus
                    value={editing.name}
                    onChange={(event) => setEditing({ id: project.id, name: event.target.value })}
                    onBlur={commit}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') commit();
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    className="ui-input h-6 w-full px-1.5 text-xs"
                    aria-label={t('directorStudio.renameProject')}
                  />
                ) : (
                  <button type="button" onDoubleClick={() => setEditing({ id: project.id, name: project.name })} className="block w-full truncate text-left text-xs font-medium text-text-dark" data-director-tooltip={t('directorStudio.renameHint')}>
                    {project.name}
                  </button>
                )}
                <div className="mt-0.5 truncate text-[10px] text-text-subtle">{formatTime(project.updatedAt)}</div>
              </div>
              <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <UiIconButton size="sm" variant="secondary" aria-label={t('directorStudio.changeCover')} data-director-tooltip={t('directorStudio.changeCover')} onClick={() => onCover(project.id)}><Camera className="h-3.5 w-3.5" /></UiIconButton>
                <UiIconButton size="sm" variant="secondary" className="text-danger" aria-label={t('common.delete')} data-director-tooltip={t('common.delete')} onClick={() => onDelete(project.id)}><Trash2 className="h-3.5 w-3.5" /></UiIconButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
