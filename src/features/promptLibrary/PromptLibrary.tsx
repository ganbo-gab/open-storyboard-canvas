import { useEffect, useMemo, useState, type UIEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Clock3,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  WifiOff,
  X,
} from 'lucide-react';
import { UiButton, UiChipButton, UiIconButton, UiInput, UiModal } from '@/components/ui';
import {
  BUNDLED_COMMUNITY_PROMPTS,
  LOCAL_PROMPTS,
  fetchCommunityPromptSource,
  mergePromptEntries,
  type PromptLibraryEntry,
} from './promptLibraryData';
import {
  useProjectStore,
  type ProjectSummary,
  type PromptCanvasTarget,
} from '@/stores/projectStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';

type FilterSetter = (value: string[]) => void;
type PromptLibraryViewMode = 'all' | 'favorites';
const INITIAL_VISIBLE_PROMPT_COUNT = 80;
const VISIBLE_PROMPT_BATCH_SIZE = 48;

function toggleFilterValue(
  value: string,
  selectedValues: string[],
  setSelectedValues: FilterSetter
) {
  if (selectedValues.includes(value)) {
    setSelectedValues(selectedValues.filter((item) => item !== value));
    return;
  }
  setSelectedValues([...selectedValues, value]);
}

function sortLabels(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}


export function resolvePromptCardLabels(
  entry: Pick<PromptLibraryEntry, 'category' | 'tags'>
): string[] {
  const seen = new Set<string>();
  return [entry.category, ...entry.tags].flatMap((value) => {
    const label = value.trim();
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [label];
  }).slice(0, 4);
}

function formatPromptDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatPromptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

interface PromptCardProps {
  entry: PromptLibraryEntry;
  isFavorite: boolean;
  favoriteLabel: string;
  removeFavoriteLabel: string;
  onOpen: () => void;
  onToggleFavorite: () => void;
}

function PromptCard({
  entry,
  isFavorite,
  favoriteLabel,
  removeFavoriteLabel,
  onOpen,
  onToggleFavorite,
}: PromptCardProps) {
  return (
    <article className="studio-card-host relative min-w-0">
      <button type="button" className="studio-card h-full w-full" onClick={onOpen}>
        <span className="studio-card__media block aspect-4/3 w-full">
          <img
            src={entry.coverUrl}
            alt={entry.title}
            draggable={false}
            loading="lazy"
          />
          <span className="studio-card__badge max-w-[calc(100%-56px)] truncate">{entry.category}</span>
          <span className="studio-card__overlay">
            <span className="truncate text-xs font-medium">{entry.source}</span>
            <span className="text-[11px] opacity-75">{formatPromptDate(entry.updatedAt)}</span>
          </span>
        </span>
        <div className="flex w-full min-w-0 flex-1 flex-col gap-2 px-1">
          <h3 className="line-clamp-2 text-sm font-medium leading-5 text-text-dark">{entry.title}</h3>
          <p className="line-clamp-2 text-xs leading-5 text-text-muted">{entry.excerpt}</p>
          <span className="mt-auto flex flex-wrap gap-1.5">
            {resolvePromptCardLabels(entry).map((label) => (
              <span key={label} className="rounded-md bg-[var(--hover)] px-2 py-1 text-[11px] text-text-muted">
                {label}
              </span>
            ))}
          </span>
        </div>
      </button>
      <div className="studio-card__actions" style={isFavorite ? { opacity: 1 } : undefined}>
        <UiIconButton
          type="button"
          variant="ghost"
          active={isFavorite}
          aria-label={isFavorite ? removeFavoriteLabel : favoriteLabel}
          title={isFavorite ? removeFavoriteLabel : favoriteLabel}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
        >
          <Heart className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />
        </UiIconButton>
      </div>
    </article>
  );
}

interface TargetChooserProps {
  isOpen: boolean;
  entryTitle: string;
  projects: ProjectSummary[];
  isApplying: boolean;
  error: string | null;
  onClose: () => void;
  onApply: (target: PromptCanvasTarget) => void;
}

function TargetChooser({
  isOpen,
  entryTitle,
  projects,
  isApplying,
  error,
  onClose,
  onApply,
}: TargetChooserProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'existing' | 'new'>(projects.length > 0 ? 'existing' : 'new');
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? '');
  const [newProjectName, setNewProjectName] = useState(entryTitle);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setMode(projects.length > 0 ? 'existing' : 'new');
    setSelectedProjectId(projects[0]?.id ?? '');
    setNewProjectName(entryTitle);
  }, [entryTitle, isOpen, projects]);

  const canApply =
    mode === 'existing' ? Boolean(selectedProjectId) : Boolean(newProjectName.trim());

  return (
    <UiModal
      isOpen={isOpen}
      title={t('promptLibrary.applyDialog.title')}
      onClose={onClose}
      widthClassName="w-[min(620px,calc(100vw-48px))]"
      footer={
        <>
          <UiButton type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!canApply || isApplying}
            onClick={() => {
              if (mode === 'existing') {
                onApply({ kind: 'existing', projectId: selectedProjectId });
                return;
              }
              onApply({ kind: 'new', name: newProjectName.trim() });
            }}
          >
            {isApplying
              ? t('promptLibrary.applyDialog.applying')
              : t('promptLibrary.applyDialog.confirm')}
          </UiButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3">
          <div className="text-xs font-medium text-text-muted">
            {t('promptLibrary.applyDialog.prompt')}
          </div>
          <div className="mt-1 truncate text-sm font-semibold text-text-dark">{entryTitle}</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <UiChipButton
            type="button"
            disabled={projects.length === 0}
            onClick={() => setMode('existing')}
            active={mode === 'existing'}
            className="h-10 justify-center text-sm"
          >
            <FolderOpen className="h-4 w-4" />
            {t('promptLibrary.applyDialog.existingProject')}
          </UiChipButton>
          <UiChipButton
            type="button"
            onClick={() => setMode('new')}
            active={mode === 'new'}
            className="h-10 justify-center text-sm"
          >
            <Plus className="h-4 w-4" />
            {t('promptLibrary.applyDialog.newProject')}
          </UiChipButton>
        </div>

        {mode === 'existing' ? (
          <div className="ui-scrollbar max-h-[260px] space-y-2 overflow-y-auto pr-1">
            {projects.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center text-sm text-text-muted">
                {t('promptLibrary.applyDialog.noProjects')}
              </div>
            ) : (
              projects.map((project) => (
                <UiButton
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedProjectId(project.id)}
                  variant="ghost"
                  className={`h-auto w-full justify-between border px-3 py-3 text-left ${
                    selectedProjectId === project.id
                      ? 'border-accent/65 bg-accent/10'
                      : 'border-[var(--line)]'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-text-dark">
                      {project.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted">
                      {t('promptLibrary.applyDialog.nodeCount', { count: project.nodeCount })}
                    </span>
                  </span>
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border ${
                      selectedProjectId === project.id
                        ? 'border-accent bg-accent'
                        : 'border-text-muted/45'
                    }`}
                  />
                </UiButton>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-xs font-medium text-text-muted" htmlFor="prompt-library-new-project">
              {t('promptLibrary.applyDialog.newProjectName')}
            </label>
            <UiInput
              id="prompt-library-new-project"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder={t('promptLibrary.applyDialog.newProjectPlaceholder')}
              autoFocus
            />
          </div>
        )}

        {error ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </UiModal>
  );
}

export function PromptLibrary() {
  const { t } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const applyPromptToCanvas = useProjectStore((state) => state.applyPromptToCanvas);
  const favoritePrompts = usePromptLibraryStore((state) => state.favoritePrompts);
  const cachedCommunityPrompts = usePromptLibraryStore((state) => state.communityPrompts);
  const cachedCommunityFetchedAt = usePromptLibraryStore((state) => state.communityFetchedAt);
  const toggleFavorite = usePromptLibraryStore((state) => state.toggleFavorite);
  const setCommunityCache = usePromptLibraryStore((state) => state.setCommunityCache);
  const [viewMode, setViewMode] = useState<PromptLibraryViewMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<PromptLibraryEntry | null>(null);
  const [chooserEntry, setChooserEntry] = useState<PromptLibraryEntry | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_PROMPT_COUNT);

  const davidWuQuery = useQuery({
    queryKey: ['prompt-library', 'community', 'davidwu-gpt-image2-prompts'],
    queryFn: ({ signal }) => fetchCommunityPromptSource('davidwu-gpt-image2-prompts', signal),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  const youMindQuery = useQuery({
    queryKey: ['prompt-library', 'community', 'youmind-nano-banana-pro'],
    queryFn: ({ signal }) => fetchCommunityPromptSource('youmind-nano-banana-pro', signal),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  const liveCommunityEntries = useMemo(
    () => mergePromptEntries([...(davidWuQuery.data ?? []), ...(youMindQuery.data ?? [])]),
    [davidWuQuery.data, youMindQuery.data]
  );
  const communityEntries = useMemo(
    () =>
      mergePromptEntries([
        ...liveCommunityEntries,
        ...cachedCommunityPrompts,
        ...BUNDLED_COMMUNITY_PROMPTS,
      ]),
    [cachedCommunityPrompts, liveCommunityEntries]
  );
  const allEntries = useMemo(
    () => mergePromptEntries([...communityEntries, ...LOCAL_PROMPTS]),
    [communityEntries]
  );
  const entriesById = useMemo(() => {
    const map = new Map<string, PromptLibraryEntry>();
    allEntries.forEach((entry) => {
      map.set(entry.id, entry);
    });
    return map;
  }, [allEntries]);

  const favoriteEntries = useMemo(() => {
    return Object.values(favoritePrompts)
      .map((entry) => entriesById.get(entry.id) ?? entry)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [entriesById, favoritePrompts]);

  const favoriteIds = useMemo(() => new Set(Object.keys(favoritePrompts)), [favoritePrompts]);
  const baseEntries = viewMode === 'favorites' ? favoriteEntries : allEntries;
  const isCommunityFetching = davidWuQuery.isFetching || youMindQuery.isFetching;

  const categoryOptions = useMemo(
    () => sortLabels(Array.from(new Set(baseEntries.map((entry) => entry.category).filter(Boolean)))),
    [baseEntries]
  );
  const sourceOptions = useMemo(
    () => sortLabels(Array.from(new Set(baseEntries.map((entry) => entry.source).filter(Boolean)))),
    [baseEntries]
  );
  const tagOptions = useMemo(
    () => sortLabels(Array.from(new Set(baseEntries.flatMap((entry) => entry.tags).filter(Boolean)))),
    [baseEntries]
  );

  const filteredEntries = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    return baseEntries.filter((entry) => {
      const searchable = [
        entry.title,
        entry.prompt,
        entry.excerpt,
        entry.category,
        entry.source,
        ...entry.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      const matchesCategory =
        selectedCategories.length === 0 || selectedCategories.includes(entry.category);
      const matchesSource = selectedSources.length === 0 || selectedSources.includes(entry.source);
      const matchesTags =
        selectedTags.length === 0 || selectedTags.every((tag) => entry.tags.includes(tag));

      return matchesSearch && matchesCategory && matchesSource && matchesTags;
    });
  }, [baseEntries, searchQuery, selectedCategories, selectedSources, selectedTags]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_PROMPT_COUNT);
  }, [
    baseEntries.length,
    searchQuery,
    selectedCategories,
    selectedSources,
    selectedTags,
    viewMode,
  ]);

  const visibleEntries = useMemo(
    () => filteredEntries.slice(0, visibleCount),
    [filteredEntries, visibleCount]
  );
  const hasMoreEntries = visibleEntries.length < filteredEntries.length;

  const selectedEntryIsFavorite = selectedEntry ? favoriteIds.has(selectedEntry.id) : false;
  const chooserEntryTitle = chooserEntry?.title ?? '';
  const liveFetchedAt = Math.max(davidWuQuery.dataUpdatedAt, youMindQuery.dataUpdatedAt, 0);
  const fetchedAtLabel =
    liveFetchedAt > 0
      ? formatPromptTime(new Date(liveFetchedAt).toISOString())
      : cachedCommunityFetchedAt
        ? formatPromptTime(cachedCommunityFetchedAt)
        : '';
  const remoteErrorCount =
    (davidWuQuery.isError ? 1 : 0) + (youMindQuery.isError ? 1 : 0);

  useEffect(() => {
    if (liveCommunityEntries.length === 0) {
      return;
    }
    const fetchedAt =
      liveFetchedAt > 0 ? new Date(liveFetchedAt).toISOString() : new Date().toISOString();
    setCommunityCache(mergePromptEntries([...liveCommunityEntries, ...cachedCommunityPrompts]), fetchedAt);
  }, [cachedCommunityPrompts, liveCommunityEntries, liveFetchedAt, setCommunityCache]);

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedCategories([]);
    setSelectedSources([]);
    setSelectedTags([]);
  };

  const activeFilterCount =
    selectedCategories.length + selectedSources.length + selectedTags.length + (searchQuery ? 1 : 0);

  const handleRefresh = () => {
    void davidWuQuery.refetch();
    void youMindQuery.refetch();
  };

  const revealMoreEntries = () => {
    setVisibleCount((current) =>
      Math.min(current + VISIBLE_PROMPT_BATCH_SIZE, filteredEntries.length)
    );
  };

  const handleLibraryScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!hasMoreEntries) {
      return;
    }

    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 420) {
      revealMoreEntries();
    }
  };

  const handleApply = async (target: PromptCanvasTarget) => {
    if (!chooserEntry) {
      return;
    }

    setIsApplying(true);
    setApplyError(null);
    try {
      await applyPromptToCanvas(target, {
        title: chooserEntry.title,
        prompt: chooserEntry.prompt,
      });
      setChooserEntry(null);
      setSelectedEntry(null);
    } catch (error) {
      console.error('Failed to apply prompt to canvas project', error);
      setApplyError(t('promptLibrary.applyDialog.error'));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div
      className="studio-page ui-scrollbar h-full min-h-0 w-full overflow-y-auto overflow-x-hidden px-6 py-8 sm:px-10"
      onScroll={handleLibraryScroll}
    >
      <div className="mx-auto max-w-[1180px] pb-10">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-dark">{t('promptLibrary.title')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">{t('promptLibrary.description')}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs text-text-muted">
              <BookOpen className="h-4 w-4" />
              {communityEntries.length > 0 ? t('promptLibrary.liveBadge') : t('promptLibrary.builtInBadge')}
            </span>
            <UiButton type="button" variant="secondary" disabled={isCommunityFetching} onClick={handleRefresh}>
              <RefreshCw className={`h-4 w-4 ${isCommunityFetching ? 'animate-spin' : ''}`} />
              {isCommunityFetching ? t('promptLibrary.refreshing') : t('promptLibrary.refresh')}
            </UiButton>
          </div>
        </header>

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <UiInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('promptLibrary.searchPlaceholder')}
              className="pl-9"
            />
          </div>

          <div className="inline-flex flex-wrap gap-2">
            <UiChipButton
              type="button"
              aria-pressed={viewMode === 'all'}
              onClick={() => setViewMode('all')}
              active={viewMode === 'all'}
            >
              <ImageIcon className="h-4 w-4" />
              {t('promptLibrary.allPrompts')}
            </UiChipButton>
            <UiChipButton
              type="button"
              aria-pressed={viewMode === 'favorites'}
              onClick={() => setViewMode('favorites')}
              active={viewMode === 'favorites'}
            >
              <Heart className={`h-4 w-4 ${viewMode === 'favorites' ? 'fill-current' : ''}`} />
              {t('promptLibrary.myFavorites', { count: favoriteEntries.length })}
            </UiChipButton>
          </div>

        </div>

        <div className="mb-6 rounded-xl border border-[var(--line)] bg-surface p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
              <span className="inline-flex items-center gap-2 text-xs">
                <ImageIcon className="h-4 w-4 text-accent" />
                {t('promptLibrary.resultCount', {
                  count: filteredEntries.length,
                  total: baseEntries.length,
                  remote: communityEntries.length,
                })}
              </span>
              <span className="inline-flex items-center gap-2 text-xs">
                <Clock3 className="h-4 w-4 text-accent" />
                {fetchedAtLabel
                  ? t('promptLibrary.lastUpdated', { time: fetchedAtLabel })
                  : t('promptLibrary.updating')}
              </span>
              {remoteErrorCount > 0 ? (
                <span className="inline-flex items-center gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  <WifiOff className="h-4 w-4" />
                  {t('promptLibrary.partialOffline')}
                </span>
              ) : null}
            </div>

            <UiButton
              type="button"
              variant="ghost"
              disabled={activeFilterCount === 0}
              onClick={clearFilters}
              className="gap-2"
            >
              <X className="h-4 w-4" />
              {t('promptLibrary.clearFilters')}
            </UiButton>
          </div>

          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-text-muted">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t('promptLibrary.categoryFilter')}
              </div>
              <div className="ui-scrollbar flex max-h-[92px] flex-wrap gap-2 overflow-y-auto pr-1">
                {categoryOptions.map((category) => {
                  const isActive = selectedCategories.includes(category);
                  return (
                    <UiChipButton
                      key={category}
                      type="button"
                      active={isActive}
                      onClick={() =>
                        toggleFilterValue(category, selectedCategories, setSelectedCategories)
                      }
                      className="h-8 text-xs"
                    >
                      {category}
                    </UiChipButton>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-text-muted">
                <Sparkles className="h-3.5 w-3.5" />
                {t('promptLibrary.sourceFilter')}
              </div>
              <div className="ui-scrollbar flex max-h-[92px] flex-wrap gap-2 overflow-y-auto pr-1">
                {sourceOptions.map((source) => {
                  const isActive = selectedSources.includes(source);
                  return (
                    <UiChipButton
                      key={source}
                      type="button"
                      active={isActive}
                      onClick={() => toggleFilterValue(source, selectedSources, setSelectedSources)}
                      className="h-8 text-xs"
                    >
                      {source}
                    </UiChipButton>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-text-muted">
                <Tag className="h-3.5 w-3.5" />
                {t('promptLibrary.tagFilter')}
              </div>
              <div className="ui-scrollbar flex max-h-[92px] flex-wrap gap-2 overflow-y-auto pr-1">
                {tagOptions.map((tag) => {
                  const isActive = selectedTags.includes(tag);
                  return (
                    <UiChipButton
                      key={tag}
                      type="button"
                      active={isActive}
                      onClick={() => toggleFilterValue(tag, selectedTags, setSelectedTags)}
                      className="h-8 text-xs"
                    >
                      {tag}
                    </UiChipButton>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {isCommunityFetching && allEntries.length === 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => <span key={index} className="studio-skeleton aspect-4/3" />)}
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] bg-surface p-12 text-center">
            <Search className="mx-auto h-10 w-10 text-text-muted/60" />
            <div className="mt-4 text-base font-semibold text-text-dark">
              {viewMode === 'favorites'
                ? t('promptLibrary.emptyFavoriteTitle')
                : t('promptLibrary.emptyTitle')}
            </div>
            <p className="mt-2 text-sm text-text-muted">
              {viewMode === 'favorites'
                ? t('promptLibrary.emptyFavoriteHint')
                : t('promptLibrary.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleEntries.map((entry) => (
              <PromptCard
                key={entry.id}
                entry={entry}
                isFavorite={favoriteIds.has(entry.id)}
                favoriteLabel={t('promptLibrary.favorite')}
                removeFavoriteLabel={t('promptLibrary.removeFavorite')}
                onOpen={() => setSelectedEntry(entry)}
                onToggleFavorite={() => toggleFavorite(entry)}
              />
            ))}
          </div>
        )}

        {filteredEntries.length > 0 ? (
          <div className="mt-6 flex justify-center">
            {hasMoreEntries ? (
              <UiButton type="button" variant="secondary" onClick={revealMoreEntries}>
                {t('promptLibrary.loadMore', {
                  visible: visibleEntries.length,
                  total: filteredEntries.length,
                })}
              </UiButton>
            ) : (
              <div className="rounded-md border border-[var(--line)] bg-surface px-3 py-2 text-xs text-text-muted">
                {t('promptLibrary.endOfList', {
                  total: filteredEntries.length,
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <UiModal
        isOpen={Boolean(selectedEntry)}
        title={selectedEntry?.title ?? ''}
        onClose={() => setSelectedEntry(null)}
        widthClassName="w-[min(980px,calc(100vw-48px))]"
        footer={
          selectedEntry ? (
            <>
              <UiButton type="button" variant="ghost" onClick={() => setSelectedEntry(null)}>
                {t('common.close')}
              </UiButton>
              <UiButton
                type="button"
                variant="secondary"
                className="gap-2"
                onClick={() => toggleFavorite(selectedEntry)}
              >
                <Heart className={`h-4 w-4 ${selectedEntryIsFavorite ? 'fill-current' : ''}`} />
                {selectedEntryIsFavorite
                  ? t('promptLibrary.removeFavorite')
                  : t('promptLibrary.favorite')}
              </UiButton>
              <UiButton
                type="button"
                variant="primary"
                className="gap-2"
                onClick={() => {
                  setApplyError(null);
                  setChooserEntry(selectedEntry);
                }}
              >
                <Sparkles className="h-4 w-4" />
                {t('promptLibrary.applyToCanvas')}
              </UiButton>
            </>
          ) : null
        }
      >
        {selectedEntry ? (
          <div className="ui-scrollbar grid max-h-[calc(100vh-220px)] gap-5 overflow-y-auto pr-1 lg:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-3">
              <img
                src={selectedEntry.coverUrl}
                alt={selectedEntry.title}
                className="aspect-4/3 w-full rounded-xl border border-[var(--line)] object-cover"
                draggable={false}
              />
              <div className="flex flex-wrap gap-2">
                <span className="rounded-md border border-[var(--line)] bg-[var(--hover)] px-2 py-1 text-xs text-text-muted">
                  {selectedEntry.category}
                </span>
                <span className="rounded-md border border-[var(--line)] bg-[var(--hover)] px-2 py-1 text-xs text-text-muted">
                  {selectedEntry.source}
                </span>
                {selectedEntry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="text-xs text-text-muted">
                {t('promptLibrary.detail.updatedAt', {
                  date: formatPromptDate(selectedEntry.updatedAt),
                })}
              </div>
            </div>

            <div className="min-w-0 space-y-3">
              <div>
                <div className="text-xs font-medium uppercase text-text-muted">
                  {t('promptLibrary.detail.fullPrompt')}
                </div>
                <pre className="ui-scrollbar mt-2 max-h-[430px] overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-4 text-sm leading-7 text-text-dark">
                  {selectedEntry.prompt}
                </pre>
              </div>
              {selectedEntry.preview ? (
                <div>
                  <div className="text-xs font-medium uppercase text-text-muted">
                    {t('promptLibrary.detail.preview')}
                  </div>
                  <pre className="ui-scrollbar mt-2 max-h-[180px] overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3 text-xs leading-6 text-text-muted">
                    {selectedEntry.preview}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </UiModal>

      <TargetChooser
        isOpen={Boolean(chooserEntry)}
        entryTitle={chooserEntryTitle}
        projects={projects}
        isApplying={isApplying}
        error={applyError}
        onClose={() => {
          if (!isApplying) {
            setChooserEntry(null);
            setApplyError(null);
          }
        }}
        onApply={handleApply}
      />
    </div>
  );
}
