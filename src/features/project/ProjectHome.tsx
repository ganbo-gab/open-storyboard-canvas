import { Suspense, lazy, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderKanban, Library, type LucideIcon } from 'lucide-react';
import { ProjectManager } from './ProjectManager';
import { UiChipButton } from '@/components/ui';

type HomeBranch = 'projects' | 'prompts';

const PromptLibrary = lazy(() =>
  import('@/features/promptLibrary/PromptLibrary').then((module) => ({
    default: module.PromptLibrary,
  }))
);

export function ProjectHome() {
  const { t } = useTranslation();
  const [activeBranch, setActiveBranch] = useState<HomeBranch>('projects');
  const branchRefs = useRef<Record<HomeBranch, HTMLButtonElement | null>>({
    projects: null,
    prompts: null,
  });

  const branches: Array<{
    id: HomeBranch;
    label: string;
    icon: LucideIcon;
  }> = [
    {
      id: 'projects',
      label: t('mainHome.canvasProjects'),
      icon: FolderKanban,
    },
    {
      id: 'prompts',
      label: t('mainHome.promptLibrary'),
      icon: Library,
    },
  ];

  const handleBranchKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: HomeBranch) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const currentIndex = branches.findIndex((branch) => branch.id === current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? branches.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + branches.length) % branches.length;
    const next = branches[nextIndex].id;
    setActiveBranch(next);
    branchRefs.current[next]?.focus();
  };

  return (
    <div className="studio-page flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 border-b border-[var(--line)] bg-surface px-4 py-3 sm:px-6 sm:py-4 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex max-w-full gap-2"
            role="tablist"
            aria-label={t('mainHome.views')}
          >
            {branches.map((branch) => {
              const Icon = branch.icon;
              const isActive = activeBranch === branch.id;
              return (
                <UiChipButton
                  ref={(element) => {
                    branchRefs.current[branch.id] = element;
                  }}
                  key={branch.id}
                  type="button"
                  id={`home-tab-${branch.id}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`home-panel-${branch.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveBranch(branch.id)}
                  onKeyDown={(event) => handleBranchKeyDown(event, branch.id)}
                  active={isActive}
                  className="h-10 px-4 text-sm"
                >
                  <Icon className="h-4 w-4" />
                  {branch.label}
                </UiChipButton>
              );
            })}
          </div>

          <div className="hidden text-sm text-text-muted md:block">
            {activeBranch === 'projects'
              ? t('mainHome.canvasProjectsHint')
              : t('mainHome.promptLibraryHint')}
          </div>
        </div>
      </div>

      <div
        key={activeBranch}
        id={`home-panel-${activeBranch}`}
        role="tabpanel"
        aria-labelledby={`home-tab-${activeBranch}`}
        tabIndex={0}
        className="ui-branch-enter min-h-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {activeBranch === 'projects' ? (
          <ProjectManager />
        ) : (
          <Suspense
            fallback={
              <div className="studio-page flex h-full items-center justify-center text-sm text-text-muted">
                {t('common.loading')}
              </div>
            }
          >
            <PromptLibrary />
          </Suspense>
        )}
      </div>
    </div>
  );
}
