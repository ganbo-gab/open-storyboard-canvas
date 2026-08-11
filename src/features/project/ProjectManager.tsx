import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FolderOpen, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { UiButton, UiModal, UiSelect } from '@/components/ui/primitives';
import { hasConfiguredImageProvider } from '@/features/canvas/application/providerAvailability';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { listModelProviders } from '@/features/canvas/models';
import { RenameDialog } from './RenameDialog';
import { ProjectPortabilityControls } from '@/features/portability/ui/ProjectPortabilityControls';

type ProjectSortField = 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

export function ProjectManager() {
  const { t } = useTranslation();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [sortField, setSortField] = useState<ProjectSortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [exportRequest, setExportRequest] = useState<{ projectId: string; projectName: string } | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{ projectId: string; projectName: string } | null>(null);
  const providerIds = useMemo(() => listModelProviders().map((provider) => provider.id), []);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
  const customProviders = useCustomProvidersStore((state) => state.providers);
  const hasConfiguredProvider = useMemo(
    () => hasConfiguredImageProvider({
      apiKeys,
      builtInProviderIds: providerIds,
      customProviders,
      dreaminaStatus,
    }),
    [apiKeys, customProviders, dreaminaStatus, providerIds]
  );

  const {
    projects,
    isOpeningProject,
    createProject,
    deleteProject,
    renameProject,
    openProject,
    refreshProjects,
    waitForProjectPersistence,
  } =
    useProjectStore();

  const handleCreateProject = () => {
    setEditingProjectId(null);
    setEditingProjectName('');
    setShowRenameDialog(true);
  };

  const handleRenameClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProjectId(id);
    setEditingProjectName(name);
    setShowRenameDialog(true);
  };

  const handleDeleteClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteRequest({ projectId: id, projectName: name });
  };

  const handleConfirmDelete = () => {
    if (!deleteRequest) {
      return;
    }
    deleteProject(deleteRequest.projectId);
    setDeleteRequest(null);
  };

  const handleConfirm = (name: string) => {
    if (editingProjectId) {
      renameProject(editingProjectId, name);
    } else {
      createProject(name);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    const direction = sortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      if (sortField === 'name') {
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }) * direction;
      }

      const left = sortField === 'createdAt' ? a.createdAt : a.updatedAt;
      const right = sortField === 'createdAt' ? b.createdAt : b.updatedAt;
      return (left - right) * direction;
    });

    return list;
  }, [projects, sortDirection, sortField]);

  return (
    <div className="ui-scrollbar h-full w-full overflow-auto px-4 py-5 sm:px-6 sm:py-7 lg:px-8" aria-busy={isOpeningProject}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 sm:mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-text-dark sm:text-2xl">{t('project.title')}</h1>
            <div className="flex items-center gap-2">
              <UiSelect
                aria-label={t('project.sortBy')}
                value={sortField}
                onChange={(event) => setSortField(event.target.value as ProjectSortField)}
                className="h-9 w-[100px] rounded-lg text-sm"
              >
                <option value="name">{t('project.sortByName')}</option>
                <option value="createdAt">{t('project.sortByCreatedAt')}</option>
                <option value="updatedAt">{t('project.sortByUpdatedAt')}</option>
              </UiSelect>
              <UiSelect
                aria-label={t('project.sortDirection')}
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as SortDirection)}
                className="h-9 w-[60px] rounded-lg text-sm"
              >
                <option value="asc">{t('project.sortAsc')}</option>
                <option value="desc">{t('project.sortDesc')}</option>
              </UiSelect>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <ProjectPortabilityControls
              projects={projects}
              exportRequest={exportRequest}
              onExportHandled={() => setExportRequest(null)}
              onImported={refreshProjects}
              onBeforeExport={waitForProjectPersistence}
            />
            <UiButton type="button" variant="primary" onClick={handleCreateProject} className="ml-auto gap-2 sm:ml-0">
              <Plus className="h-4 w-4" />
              {t('project.newProject')}
            </UiButton>
          </div>
        </div>

        {!hasConfiguredProvider && <MissingApiKeyHint className="mb-8" />}

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-text-muted sm:py-20">
            <FolderOpen className="mb-4 h-14 w-14 opacity-45" />
            <p className="text-base font-medium text-text-dark">{t('project.empty')}</p>
            <p className="mt-2 max-w-xs text-sm">{t('project.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sortedProjects.map((project) => (
              <article
                key={project.id}
                className="ui-project-card group relative min-h-[136px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark p-4 transition-[border-color,background-color,box-shadow,transform] duration-150 hover:border-accent/45 hover:shadow-[var(--ui-shadow-panel)]"
              >
                <button
                  type="button"
                  aria-label={`${t('project.open')}: ${project.name}`}
                  disabled={isOpeningProject}
                  onClick={() => openProject(project.id)}
                  className="absolute inset-0 z-0 rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                >
                  <span className="sr-only">{`${t('project.open')}: ${project.name}`}</span>
                </button>

                <div className="pointer-events-none relative z-10 flex h-full flex-col">
                  <div className="mb-3 flex min-w-0 items-start justify-between gap-2">
                    <h3 className="min-w-0 flex-1 truncate font-semibold text-text-dark">
                      {project.name}
                    </h3>
                    <div className="ui-project-actions pointer-events-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setExportRequest({ projectId: project.id, projectName: project.name });
                        }}
                        className="ui-project-action inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                        title={t('portability.project.exportAction')}
                        aria-label={`${t('portability.project.exportAction')}: ${project.name}`}
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleRenameClick(project.id, project.name, e)}
                        className="ui-project-action inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                        title={t('project.rename')}
                        aria-label={`${t('project.rename')}: ${project.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteClick(project.id, project.name, e)}
                        className="ui-project-action inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                        title={t('project.delete')}
                        aria-label={`${t('project.delete')}: ${project.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-auto space-y-1 text-xs text-text-muted">
                    <p>
                      {t('project.modified')}: {formatDate(project.updatedAt)}
                    </p>
                    <p>
                      {t('project.nodes')}: {project.nodeCount}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {isOpeningProject && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-40 flex items-center justify-center bg-black/20 backdrop-blur-[1px]`}
        >
          <div className="ui-work-status inline-flex min-w-[180px] items-center justify-center gap-2 rounded-lg border border-border-dark bg-surface-dark/95 px-4 py-3 text-sm font-medium text-text-dark shadow-[var(--ui-shadow-panel)]">
            <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
            <span>{t('project.opening')}</span>
          </div>
        </div>
      )}

      <RenameDialog
        isOpen={showRenameDialog}
        title={editingProjectId ? t('project.renameTitle') : t('project.newProjectTitle')}
        defaultValue={editingProjectName}
        onClose={() => setShowRenameDialog(false)}
        onConfirm={handleConfirm}
      />

      <UiModal
        isOpen={Boolean(deleteRequest)}
        title={t('project.deleteConfirmTitle')}
        onClose={() => setDeleteRequest(null)}
        widthClassName="w-[min(420px,calc(100vw-1.5rem))]"
        containerClassName="z-[100]"
        footer={(
          <>
            <UiButton type="button" variant="ghost" onClick={() => setDeleteRequest(null)}>
              {t('common.cancel')}
            </UiButton>
            <UiButton
              type="button"
              className="bg-red-600 text-white hover:bg-red-500"
              onClick={handleConfirmDelete}
            >
              {t('project.delete')}
            </UiButton>
          </>
        )}
      >
        <p className="text-sm leading-6 text-text-muted">
          {t('project.deleteConfirmDescription', { name: deleteRequest?.projectName ?? '' })}
        </p>
      </UiModal>
    </div>
  );
}
