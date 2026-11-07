import type { ReactNode } from 'react';
import {
  Aperture,
  ArrowLeft,
  Box,
  ChevronDown,
  Clapperboard,
  Film,
  Grid2X2,
  FolderOpen,
  PanelRight,
  Redo2,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiSegmented } from '@/components/ui';

type Props = {
  mode: 'director' | 'previs';
  dirty: boolean;
  projectName: string;
  projectsOpen: boolean;
  projectsMenu: ReactNode;
  agentOpen: boolean;
  dockOpen: boolean;
  canRecord: boolean;
  shortcuts: { undo: string; redo: string; save: string; screenshot: string };
  onBack: () => void;
  onMode: (mode: 'director' | 'previs') => void;
  onToggleProjects: () => void;
  onSave: () => void;
  onCapture: () => void;
  onCaptureOptions?: () => void;
  onRecord: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleDock: () => void;
  onAgent: () => void;
};

/** Stage title bar: where am I (project + mode), history, outputs, panels. */
export function StageHeader({
  mode,
  dirty,
  projectName,
  projectsOpen,
  projectsMenu,
  agentOpen,
  dockOpen,
  canRecord,
  shortcuts,
  onBack,
  onMode,
  onToggleProjects,
  onSave,
  onCapture,
  onCaptureOptions,
  onRecord,
  onUndo,
  onRedo,
  onToggleDock,
  onAgent,
}: Props) {
  const { t } = useTranslation();
  return (
    <header className="relative z-50 grid h-[52px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-[var(--line)] bg-surface/90 px-2.5 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-1.5">
        <UiIconButton onClick={onBack} aria-label={t('titleBar.back')} data-director-tooltip={t('titleBar.back')}>
          <ArrowLeft className="h-4 w-4" />
        </UiIconButton>
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={onToggleProjects}
            aria-haspopup="dialog"
            aria-expanded={projectsOpen}
            className="group flex h-9 min-w-0 max-w-[280px] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-[var(--hover)] aria-expanded:bg-[var(--press)]"
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-text-subtle group-hover:text-text-muted" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold leading-4 text-text-dark">{projectName}</span>
              <span className={`flex items-center gap-1 text-[10px] leading-3 ${dirty ? 'text-warning' : 'text-text-subtle'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-warning' : 'bg-success/80'}`} />
                {t(dirty ? 'directorStudio.unsaved' : 'directorStudio.saved')}
              </span>
            </span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform ${projectsOpen ? 'rotate-180' : ''}`} />
          </button>
          {projectsOpen ? projectsMenu : null}
        </div>
      </div>

      <UiSegmented
        value={mode}
        options={([
          ['director', Box],
          ['previs', Film],
        ] as const).map(([value, Icon]) => ({
          value,
          label: t(`directorStudio.studioMode.${value}`),
          icon: <Icon className="h-3.5 w-3.5" />,
          buttonProps: { 'data-director-tooltip': t(`directorStudio.studioMode.${value}Help`) },
        }))}
        onChange={onMode}
        size="sm"
        className="shrink-0"
        aria-label={t('directorStudio.studioMode.label')}
      />

      <div className="flex min-w-0 items-center justify-end gap-1">
        <UiIconButton onClick={onUndo} aria-label={t('rework.canvas.undo')} data-director-tooltip={t('rework.canvas.undo')} data-director-tooltip-keys={shortcuts.undo}>
          <Undo2 className="h-4 w-4" />
        </UiIconButton>
        <UiIconButton onClick={onRedo} aria-label={t('directorStudio.redo')} data-director-tooltip={t('directorStudio.redo')} data-director-tooltip-keys={shortcuts.redo}>
          <Redo2 className="h-4 w-4" />
        </UiIconButton>
        <span className="mx-1 h-5 w-px bg-[var(--line-strong)]" />
        <UiButton onClick={onCapture} aria-label={t('directorStudio.toolbar.screenshot')} data-director-tooltip={t('directorStudio.captureHelp')} data-director-tooltip-keys={shortcuts.screenshot} size="sm" variant="ghost" icon={<Aperture className="h-4 w-4" />}>
          <span className="hidden xl:inline">{t('directorStudio.toolbar.screenshot')}</span>
        </UiButton>
        {onCaptureOptions ? <UiIconButton onClick={onCaptureOptions} aria-label={t('ui.stage.capture.title')} data-director-tooltip={t('ui.stage.capture.title')}><Grid2X2 className="h-4 w-4" /></UiIconButton> : null}
        {mode === 'previs' ? (
          <UiButton onClick={onRecord} disabled={!canRecord} aria-label={t('directorStudio.previs.record')} data-director-tooltip={t(canRecord ? 'directorStudio.previs.recordHelp' : 'directorStudio.motion.export.needsCamera')} size="sm" variant="ghost" icon={<Clapperboard className="h-4 w-4" />}>
            <span className="hidden xl:inline">{t('directorStudio.previs.record')}</span>
          </UiButton>
        ) : null}
        <span className="mx-1 h-5 w-px bg-[var(--line-strong)]" />
        <UiIconButton onClick={onToggleDock} active={dockOpen} aria-pressed={dockOpen} aria-label={t('directorStudio.dock.toggle')} data-director-tooltip={t('directorStudio.dock.toggle')}>
          <PanelRight className="h-4 w-4" />
        </UiIconButton>
        <UiButton onClick={onAgent} aria-pressed={agentOpen} aria-label={t('rework.agent.stage')} data-director-tooltip={t('rework.agent.stage')} variant={agentOpen ? 'accent' : 'secondary'} size="sm" icon={<Sparkles className="h-4 w-4" />}>
          <span className="hidden lg:inline">{t('rework.agent.stage')}</span>
        </UiButton>
        <UiButton onClick={onSave} aria-label={t('directorStudio.saveProject')} data-director-tooltip={t('directorStudio.saveProject')} data-director-tooltip-keys={shortcuts.save} variant="primary" size="sm" icon={<Save className="h-4 w-4" />}>
          <span className="hidden lg:inline">{t('directorStudio.saveProject')}</span>
        </UiButton>
      </div>
    </header>
  );
}
