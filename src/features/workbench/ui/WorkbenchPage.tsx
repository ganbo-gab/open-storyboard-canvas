import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, Clapperboard, MessageSquarePlus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkbenchStore, canDeleteWorkbenchTask, selectWorkbenchConversations } from '../store/workbenchStore';
import { WorkbenchComposer } from './WorkbenchComposer';
import { GenerationCard } from './GenerationCard';
import { MenuItem, MenuSurface, anchorBelow, UiButton, UiConfirm, UiIconButton, UiSelect, type MenuAnchor } from '@/components/ui';
import { RenameDialog } from '@/features/project/RenameDialog';
import { useProjectStore } from '@/stores/projectStore';
import { SidebarResizeHandle, useSidebarWidth } from '@/components/ui/SidebarResizeHandle';
import { ConversationProjectPicker } from './ConversationProjectPicker';
import { useConversationScroll } from '@/features/agents/ui/useConversationScroll';

export function WorkbenchPage({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation();
  const conversations = useWorkbenchStore((state) => state.conversations);
  const selected = useWorkbenchStore((state) => state.selectedConversationId);
  const tasks = useWorkbenchStore((state) => state.tasks);
  const initialized = useWorkbenchStore((state) => state.initialized);
  const initialize = useWorkbenchStore((state) => state.initialize);
  const projects = useProjectStore((state) => state.projects);
  const sidebar = useSidebarWidth('workbench-history', 252, 200, 480, 440);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileHistory, setMobileHistory] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void initialize().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, [initialize]);
  const visible = useMemo(() => Object.values(tasks).filter((task) => task.conversationId === selected).sort((a, b) => a.createdAt - b.createdAt), [tasks, selected]);
  useEffect(() => {
    if (!initialized || !selected) return;
    // Old Comfy batches cached only the first result. Read their original job once
    // when opening a conversation so the durable full result list becomes visible.
    const state = useWorkbenchStore.getState();
    for (const task of Object.values(state.tasks)) {
      if (task.conversationId === selected && task.status === 'succeeded' && task.jobId?.startsWith('custom-local-comfy-v2-')) void state.poll(task.id);
    }
  }, [initialized, selected]);
  const contentVersion = visible.map((task) => `${task.id}:${task.status}:${task.results.length}`).join('|');
  const { scrollRef, onScroll, browsingHistory, showNewItems, jumpToLatest } = useConversationScroll(selected, contentVersion);
  const history = selectWorkbenchConversations({ conversations }, { text: search, ...(projectFilter === 'all' ? {} : { projectId: projectFilter === 'none' ? null : projectFilter }) });
  const canDelete = (id: string) => Object.values(tasks).filter((task) => task.conversationId === id).every(canDeleteWorkbenchTask);
  const createConversation = () => { useWorkbenchStore.getState().createConversation(t('ui.workbench.newConversation'), projectFilter === 'all' || projectFilter === 'none' ? null : projectFilter); setMobileHistory(false); };
  return <div className="workbench-layout" data-history-collapsed={collapsed || undefined}>
    {mobileHistory && <button type="button" className="workbench-history-scrim" aria-label={t('common.close')} onClick={() => setMobileHistory(false)} />}
    <aside ref={sidebar.ref} className="workbench-history" data-mobile-open={mobileHistory || undefined}>
      <div className="flex items-center gap-2"><UiButton variant="secondary" className="min-h-10 flex-1 justify-start" icon={<MessageSquarePlus />} onClick={createConversation}>{t('ui.workbench.newConversation')}</UiButton><UiIconButton title={t('ui.workbench.hideHistory')} aria-label={t('ui.workbench.hideHistory')} onClick={() => { setCollapsed(true); setMobileHistory(false); }}><PanelLeftClose /></UiIconButton></div>
      <label className="workbench-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('ui.workbench.searchHistory')} aria-label={t('ui.workbench.searchHistory')} /></label>
      {projects.length > 0 && <UiSelect className="h-8 text-xs" aria-label={t('ui.workbench.projectFilter')} value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">{t('ui.workbench.allProjects')}</option><option value="none">{t('ui.workbench.ungrouped')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</UiSelect>}
      <p className="px-2 text-xs text-text-subtle">{t('rework.history')} · {history.length}</p>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto">
        {history.map((conversation) => <div key={conversation.id} className="workbench-history-item" data-active={selected === conversation.id || undefined}>
          <button type="button" className="min-w-0 flex-1 py-3 pl-3 text-left" onClick={() => { useWorkbenchStore.getState().selectConversation(conversation.id); setMobileHistory(false); }}><span className="flex items-center gap-2">{conversation.pinnedAt !== null && <Pin size={12} className="shrink-0" />}<span className="truncate text-sm">{conversation.title}</span></span><span className="mt-1 block truncate text-xs text-text-subtle">{new Date(conversation.updatedAt).toLocaleDateString()} · {Object.values(tasks).filter((task) => task.conversationId === conversation.id).length} {t('ui.workbench.generations')}</span></button>
          <UiIconButton size="sm" title={t('rework.more')} aria-label={`${conversation.title} · ${t('rework.more')}`} onClick={(event) => { setMenu(current => current?.id === conversation.id ? null : { id: conversation.id, anchor: anchorBelow(event.currentTarget) }); }}><MoreHorizontal /></UiIconButton>
        </div>)}
        {!history.length && <p className="px-3 py-8 text-center text-sm text-text-subtle">{search ? t('rework.noMatches') : t('ui.workbench.historyEmpty')}</p>}
      </div>
      <SidebarResizeHandle {...sidebar} label="创作记录宽度" />
    </aside>
    <section className="workbench-main studio-page">
      <header className="workbench-header"><UiIconButton className={collapsed ? '' : 'lg:hidden'} title={t('rework.history')} aria-label={t('rework.history')} onClick={() => { setCollapsed(false); setMobileHistory((value) => !value); }}><PanelLeftOpen /></UiIconButton><Clapperboard size={18} className="shrink-0 text-text-muted" /><h1 className="min-w-0 flex-1 truncate text-sm font-medium">{selected ? conversations[selected]?.title : t('rework.workbench')}</h1>
        {selected && <ConversationProjectPicker conversationId={selected} onFilter={setProjectFilter} />}
        <UiIconButton title={t('ui.workbench.newConversation')} aria-label={t('ui.workbench.newConversation')} onClick={createConversation}><MessageSquarePlus /></UiIconButton>
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="workbench-feed ui-scrollbar"><div className="workbench-feed__content">
        {!visible.length && <div className="workbench-empty"><span className="workbench-empty__icon"><Clapperboard size={28} /></span><p className="mb-2 text-xs font-medium tracking-[.16em] text-text-subtle">{t('ui.workbench.eyebrow')}</p><h2>{initialized ? t('ui.workbench.emptyTitle') : t('common.loading')}</h2><p>{t('ui.workbench.emptyHint')}</p><div className="mt-6 flex flex-wrap justify-center gap-2">{(['image', 'video', 'audio'] as const).map((kind) => <UiButton key={kind} variant="secondary" onClick={() => useWorkbenchStore.getState().setDraft({ kind })}>{t(`rework.${kind}`)}</UiButton>)}</div></div>}
        {visible.map((task) => <GenerationCard key={task.id} task={task} />)}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div></div>
      {visible.length > 2 && <nav className="workbench-directory" aria-label={t('ui.workbench.directory')}>{visible.map((task, index) => <button key={task.id} type="button" title={task.input.prompt} aria-label={`${index + 1}. ${task.input.prompt}`} onClick={() => document.getElementById(`generation-${task.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><span>{index + 1}</span></button>)}</nav>}
      <div className="workbench-composer-wrap">{showNewItems && <UiButton variant="secondary" className="workbench-jump" icon={<ArrowDown />} onClick={jumpToLatest}>{t('ui.agent.newMessages')}</UiButton>}<WorkbenchComposer browsing={browsingHistory} onSettings={onSettings} onSubmitted={jumpToLatest} /></div>
    </section>
    {menu && <MenuSurface anchor={menu.anchor} onClose={() => setMenu(null)} width={220} label={t('rework.more')}><MenuItem icon={<Pin />} label={t(conversations[menu.id]?.pinnedAt !== null ? 'ui.workbench.unpin' : 'ui.workbench.pin')} onClick={() => { useWorkbenchStore.getState().setConversationPinned(menu.id, conversations[menu.id].pinnedAt === null); setMenu(null); }} /><MenuItem icon={<Pencil />} label={t('rework.rename')} onClick={() => { setRenaming(menu.id); setMenu(null); }} /><MenuItem icon={<Trash2 />} disabled={!canDelete(menu.id)} label={t(canDelete(menu.id) ? 'rework.delete' : 'ui.workbench.unresolvedTasks')} onClick={() => { setDeleting(menu.id); setMenu(null); }} /></MenuSurface>}
    <RenameDialog isOpen={Boolean(renaming)} title={t('rework.rename')} defaultValue={renaming ? conversations[renaming]?.title : ''} onClose={() => setRenaming(null)} onConfirm={(name) => { if (renaming) useWorkbenchStore.getState().renameConversation(renaming, name); }} />
    <UiConfirm isOpen={Boolean(deleting)} title={t('rework.delete')} description={t('rework.confirmDelete')} confirmLabel={t('rework.delete')} onClose={() => setDeleting(null)} onConfirm={() => { if (!deleting) return; try { useWorkbenchStore.getState().deleteConversation(deleting); } catch { setError(t('ui.workbench.unresolvedTasks')); } }} />
  </div>;
}
