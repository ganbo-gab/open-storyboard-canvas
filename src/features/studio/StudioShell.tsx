import { lazy, Suspense, useEffect, useState, type DragEvent, type ReactNode } from "react";
import {
  BookOpen,
  Boxes,
  Clapperboard,
  FolderKanban,
  Home,
  Images,
  ListTodo,
  Loader2,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Sparkles,
  SquareDashed,
  Users,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/projectStore";
import { SidebarResizeHandle, useSidebarWidth } from "@/components/ui/SidebarResizeHandle";
import { UiButton } from "@/components/ui";
import { ProjectManager } from "@/features/project/ProjectManager";
import { StudioHome } from "./StudioHome";
import { launchLocation, writeAppLocation, type StudioView } from "./appLocation";
import { hasStudioMediaDrag, readStudioMediaDrag, type StudioMediaDrag } from "./mediaDrag";
import { MediaImportDialog } from "./MediaImportDialog";
import { importStudioMedia } from "./importStudioMedia";
import { TaskDrawer } from "./TaskDrawer";
import { selectActiveTaskCount, selectAttentionTaskCount, useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import type { WorkbenchTask } from "@/features/workbench/domain/types";
import { subscribeStudioNavigation } from "./studioNavigation";
import { useCanvasStore } from "@/stores/canvasStore";
import { canvasNavigationFacade } from "@/features/canvas/application/canvasNavigationFacade";

const WorkbenchPage = lazy(() =>
  import("@/features/workbench/ui/WorkbenchPage").then((module) => ({
    default: module.WorkbenchPage,
  })),
);
const AssetLibraryPage = lazy(() =>
  import("@/features/assets/ui/AssetLibraryPage").then((module) => ({
    default: module.AssetLibraryPage,
  })),
);
const PromptLibrary = lazy(() =>
  import("@/features/promptLibrary/PromptLibrary").then((module) => ({
    default: module.PromptLibrary,
  })),
);
const ScopedAgentPanel = lazy(() =>
  import("@/features/agents/ui/ScopedAgentPanel").then((module) => ({
    default: module.ScopedAgentPanel,
  })),
);
// Library pages include editors and Markdown; defer these chunks so canvas launch stays lean.
const CharacterLibraryPage = lazy(() => import("@/features/characters/ui/CharacterLibraryPage").then(module => ({ default: module.CharacterLibraryPage })));
const LibraryHubPage = lazy(() => import("@/features/library/ui/LibraryHubPage").then(module => ({ default: module.LibraryHubPage })));
const KnowledgeLibraryPage = lazy(() => import("@/features/knowledge/ui/KnowledgeLibraryPage").then(module => ({ default: module.KnowledgeLibraryPage })));


type View = StudioView;
type Props = { children: ReactNode; onSettings: () => void };
const navigation = [
  { id: "home", icon: Home, label: "home" },
  { id: "workbench", icon: Clapperboard, label: "workbench" },
  { id: "projects", icon: FolderKanban, label: "projects" },
  { id: "assets", icon: Images, label: "assets" },
  { id: "characters", icon: Users, label: "charactersNav" },
  { id: "library", icon: Boxes, label: "libraryHub.title" },
  { id: "knowledge", icon: NotebookPen, label: "knowledge.title" },
  { id: "prompts", icon: BookOpen, label: "prompts" },
  { id: "agent", icon: Sparkles, label: "agent.home" },
] as const;

const RECENT_IN_NAV = 5;

/** The workbench page is lazy; wait (bounded) for the task card to mount before scrolling to it. */
function scrollToTaskCard(taskId: string, deadline = performance.now() + 3000) {
  const card = document.getElementById(`generation-${taskId}`);
  if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (performance.now() < deadline) requestAnimationFrame(() => scrollToTaskCard(taskId, deadline));
}

export function StudioShell({ children, onSettings }: Props) {
  const { t } = useTranslation();
  const projectId = useProjectStore((state) => state.currentProjectId);
  const projects = useProjectStore((state) => state.projects);
  const openingProject = useProjectStore((state) => state.isOpeningProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const openProject = useProjectStore((state) => state.openProject);
  const createProject = useProjectStore((state) => state.createProject);
  // A canvas launch shows home until App re-opens the project (the store has no project yet).
  const [view, setView] = useState<View>(() => (launchLocation.view === "canvas" ? "home" : launchLocation.view));
  const [collapsed, setCollapsed] = useState(false);
  const compact = collapsed || !!projectId;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<StudioMediaDrag | null>(null);
  const sidebar = useSidebarWidth("studio-navigation", 240, 180, 360, 680);
  const [dropNotice, setDropNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<{ projectId: string; nodeId: string } | null>(null);
  useEffect(() => {
    if (!dropNotice) return;
    const timer = window.setTimeout(() => setDropNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [dropNotice]);
  /** 项目 opens a destination picker; a recent canvas imports straight into that project. */
  const dropHandlers = (target: string, projectIdTarget?: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!hasStudioMediaDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((current) => (current === target ? null : current)),
    onDrop: (event: DragEvent) => {
      const payload = readStudioMediaDrag(event.dataTransfer);
      setDropTarget(null);
      if (!payload) return;
      event.preventDefault();
      if (!projectIdTarget) { setPendingDrop(payload); return; }
      const name = projects.find((project) => project.id === projectIdTarget)?.name ?? "";
      void importStudioMedia(payload, projectIdTarget).then(
        (nodeIds) => setDropNotice({ tone: "ok", text: t("rework.mediaDrop.imported", { name, count: nodeIds.length }) }),
        (cause: unknown) => setDropNotice({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) }),
      );
    },
  });
  useEffect(() => {
    if (projectId) setView("canvas");
    else setView((current) => (current === "canvas" ? "home" : current));
  }, [projectId]);
  const activeTasks = useWorkbenchStore(selectActiveTaskCount);
  const attentionTasks = useWorkbenchStore(selectAttentionTaskCount);
  const taskSummary = activeTasks > 0 && attentionTasks > 0
    ? t("rework.taskDrawer.summary", { running: activeTasks, attention: attentionTasks })
    : t(activeTasks > 0 ? "rework.taskDrawer.badge" : "rework.taskDrawer.attentionBadge", { count: activeTasks || attentionTasks });
  const [taskDrawer, setTaskDrawer] = useState(false);
  // Reconcile locally before scheduling queries; returning to a sleeping window must not imply live work.
  useEffect(() => {
    void useWorkbenchStore.getState().initialize();
    const reconcile = () => useWorkbenchStore.getState().reconcileTasks();
    const timer = window.setInterval(reconcile, 60000);
    window.addEventListener("focus", reconcile);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", reconcile); };
  }, []);
  const openTask = (task: WorkbenchTask) => {
    setTaskDrawer(false);
    useWorkbenchStore.getState().selectConversation(task.conversationId);
    navigate("workbench");
    scrollToTaskCard(task.id);
  };
  // While a project opens (launch restore, or a click), the shell still shows the previous page;
  // recording that would replace the destination in the URL.
  useEffect(() => {
    if (openingProject) return;
    writeAppLocation(view === "canvas" && projectId ? { view: "canvas", projectId } : { view: view === "canvas" ? "home" : view });
  }, [openingProject, projectId, view]);
  const navigate = (next: View) => {
    setPendingFocus(null);
    if (projectId) closeProject();
    setView(next);
  };
  const newCanvas = () => createProject(t("rework.untitled"));
  const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_IN_NAV);
  const onCanvas = view === "canvas" && !!projectId;
  useEffect(() => subscribeStudioNavigation((request) => {
    if (request.kind === "page") {
      setPendingFocus(null);
      if (useProjectStore.getState().currentProjectId) closeProject();
      setView(request.view);
      return;
    }
    const target = request.target;
    const fail = () => setDropNotice({ tone: "error", text: t("rework.generationHistory.sourceMissing") });
    if (target.surface === "workbench") {
      const workbench = useWorkbenchStore.getState();
      if (!workbench.conversations[target.conversationId] || !workbench.tasks[target.taskId]) { fail(); return; }
      setPendingFocus(null);
      if (useProjectStore.getState().currentProjectId) closeProject();
      workbench.selectConversation(target.conversationId);
      setView("workbench");
      scrollToTaskCard(target.taskId);
      return;
    }
    const targetProject = target.projectId ?? useProjectStore.getState().currentProjectId;
    if (!targetProject || !projects.some(project => project.id === targetProject)) { fail(); return; }
    setPendingFocus({ projectId: targetProject, nodeId: target.nodeId });
    if (useProjectStore.getState().currentProjectId !== targetProject) openProject(targetProject);
    else setView("canvas");
  }), [closeProject, openProject, projects, t]);

  useEffect(() => {
    if (!pendingFocus || openingProject) return;
    if (projectId !== pendingFocus.projectId) {
      setDropNotice({ tone: "error", text: t("rework.generationHistory.sourceMissing") });
      setPendingFocus(null);
      return;
    }
    if (!onCanvas) return;
    let cancelled = false;
    let frame = 0;
    const deadline = performance.now() + 10_000;
    const focus = async () => {
      if (cancelled) return;
      const store = useCanvasStore.getState();
      const node = store.nodes.find(item => item.id === pendingFocus.nodeId);
      if (node?.hidden && typeof node.data.batchId === "string") store.setBatchPrimary(node.data.batchId, node.id);
      if (node && canvasNavigationFacade.isAvailable()
        && await canvasNavigationFacade.focusNodeIds([node.id], { select: true, padding: 0.4 })) {
        if (!cancelled) setPendingFocus(null);
      } else if (!cancelled && performance.now() < deadline) {
        frame = requestAnimationFrame(() => { void focus(); });
      } else if (!cancelled) {
        setDropNotice({ tone: "error", text: t("rework.generationHistory.sourceMissing") });
        setPendingFocus(null);
      }
    };
    frame = requestAnimationFrame(() => { void focus(); });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [pendingFocus, projectId, openingProject, onCanvas, t]);

  return (
    <div className="studio-shell flex h-full min-h-0 min-w-0 bg-bg">
      {!onCanvas && (
      <aside
        ref={sidebar.ref}
        data-compact={compact || undefined}
        className="studio-navigation relative flex shrink-0 flex-col"
      >
        <UiButton variant="ghost"
          type="button"
          title={t("rework.home")}
          aria-label={t("rework.home")}
          onClick={() => navigate("home")}
          className="h-14 shrink-0 justify-start gap-2.5 overflow-hidden rounded-none px-[14px] text-text-dark"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--primary-bg)] text-[var(--primary-fg)] shadow-[0_6px_18px_rgb(var(--accent-rgb)/0.35)]">
            <Workflow className="h-4 w-4" />
          </span>
          {!compact && (
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight max-[760px]:hidden">
              {t("rework.brand")}
            </span>
          )}
        </UiButton>
        <div className="px-2.5 pt-2">
          <UiButton variant="primary"
            type="button"
            onClick={newCanvas}
            title={t("rework.newCanvas")}
            aria-label={t("rework.newCanvas")}
            className="h-[38px] w-full overflow-hidden rounded-[var(--r-md)] text-[13.5px]"
          >
            <Plus className="h-4 w-4 shrink-0" />
            {!compact && <span className="max-[760px]:hidden">{t("rework.newCanvas")}</span>}
          </UiButton>
        </div>
        <nav
          aria-label={t("rework.brand")}
          className="ui-scrollbar mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5"
        >
          <div className="space-y-0.5">
            {navigation.map((item) => {
              const active =
                view === item.id || (view === "canvas" && item.id === "projects");
              const Icon = item.icon;
              return (
                <UiButton variant="ghost"
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  {...(item.id === "projects" ? dropHandlers("projects") : {})}
                  data-drop-target={dropTarget === item.id && item.id === "projects" ? "" : undefined}
                  title={t(`rework.${item.label}`)}
                  aria-label={t(`rework.${item.label}`)}
                  aria-current={active ? "page" : undefined}
                  className={`studio-drop-target relative h-[38px] w-full justify-start gap-3 overflow-hidden rounded-[var(--r-md)] px-[11px] text-[13.5px] max-[760px]:justify-center max-[760px]:px-2 ${active ? 'bg-[var(--press)] font-medium text-text-dark' : 'font-normal text-text-muted'}`}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  {!compact && (
                    <span className="whitespace-nowrap max-[760px]:hidden">
                      {t(`rework.${item.label}`)}
                    </span>
                  )}
                  {item.id === "workbench" && activeTasks > 0 && (
                    <span className="studio-nav-badge" data-corner={compact ? "" : undefined} aria-label={t("rework.taskDrawer.badge", { count: activeTasks })}>{activeTasks}</span>
                  )}
                </UiButton>
              );
            })}
          </div>
          {(activeTasks > 0 || attentionTasks > 0) && (
            <UiButton variant="ghost"
              type="button"
              onClick={() => setTaskDrawer(!taskDrawer)}
              aria-expanded={taskDrawer}
              title={taskSummary}
              aria-label={taskSummary}
              className="mt-1 h-8 w-full justify-start gap-3 overflow-hidden rounded-[var(--r-md)] px-[11px] text-[12.5px] font-normal text-text-muted max-[760px]:justify-center max-[760px]:px-2"
            >
              <ListTodo className="h-4 w-4 shrink-0" />
              {!compact && <span className="min-w-0 truncate max-[760px]:hidden">{taskSummary}</span>}
            </UiButton>
          )}
          {!compact && recent.length > 0 && (
            <div className="max-[760px]:hidden">
              <p className="studio-nav-label">{t("rework.recentCanvases")}</p>
              <div className="space-y-0.5">
                {recent.map((project) => (
                  <UiButton variant="ghost"
                    key={project.id}
                    type="button"
                    {...dropHandlers(`project:${project.id}`, project.id)}
                    data-drop-target={dropTarget === `project:${project.id}` ? "" : undefined}
                    className="studio-drop-target h-8 w-full justify-start gap-2.5 rounded-[var(--r-sm)] px-[11px] text-[12.5px] font-normal text-text-muted"
                    title={project.name}
                    onClick={() => openProject(project.id)}
                  >
                    <SquareDashed className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{project.name}</span>
                  </UiButton>
                ))}
              </div>
            </div>
          )}
        </nav>
        <div className="space-y-0.5 border-t border-[var(--line)] p-2.5">
          <UiButton variant="ghost"
            type="button"
            onClick={onSettings}
            title={t("rework.settings")}
            aria-label={t("rework.settings")}
            className="h-[38px] w-full justify-start gap-3 overflow-hidden rounded-[var(--r-md)] px-[11px] text-[13.5px] font-normal text-text-muted max-[760px]:justify-center max-[760px]:px-2"
          >
            <Settings2 className="h-[18px] w-[18px] shrink-0" />
            {!compact && (
              <span className="whitespace-nowrap max-[760px]:hidden">
                {t("rework.settings")}
              </span>
            )}
          </UiButton>
          {!projectId && (
            <UiButton variant="ghost"
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              title={t(compact ? "rework.expand" : "rework.collapse")}
              aria-label={t(compact ? "rework.expand" : "rework.collapse")}
              className="h-[38px] w-full justify-start gap-3 overflow-hidden rounded-[var(--r-md)] px-[11px] text-[13.5px] font-normal text-text-muted max-[760px]:hidden"
            >
              {compact ? <PanelLeftOpen className="h-[18px] w-[18px] shrink-0" /> : <PanelLeftClose className="h-[18px] w-[18px] shrink-0" />}
              {!compact && <span className="whitespace-nowrap text-[12.5px]">{t("rework.collapse")}</span>}
            </UiButton>
          )}
        </div>
        {!compact && <SidebarResizeHandle {...sidebar} label="主导航宽度" />}
      </aside>
      )}
      {dropNotice && (
        <div role={dropNotice.tone === "error" ? "alert" : "status"} className="studio-drop-notice" data-tone={dropNotice.tone}>
          {dropNotice.text}
        </div>
      )}
      {pendingDrop && <MediaImportDialog payload={pendingDrop} onClose={() => setPendingDrop(null)} />}
      {taskDrawer && <TaskDrawer onClose={() => setTaskDrawer(false)} onOpenTask={openTask} />}
      <div className="relative min-h-0 min-w-0 flex-1">
        <Suspense
          fallback={
            <div
              role="status"
              className="flex h-full items-center justify-center gap-3 text-sm text-text-muted"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("common.loading")}
            </div>
          }
        >
          {view === "canvas" && projectId ? (
            children
          ) : view === "projects" ? (
            <ProjectManager />
          ) : view === "workbench" ? (
            <WorkbenchPage onSettings={onSettings} />
          ) : view === "assets" ? (
            <AssetLibraryPage onUseReference={() => navigate("workbench")} />
          ) : view === "characters" ? (
            <CharacterLibraryPage />
          ) : view === "library" ? (
            <LibraryHubPage onWorkbench={() => navigate("workbench")} />
          ) : view === "knowledge" ? (
            <KnowledgeLibraryPage />
          ) : view === "prompts" ? (
            <PromptLibrary />
          ) : view === "agent" ? (
            <ScopedAgentPanel scope="home" onSettings={onSettings} />
          ) : (
            <StudioHome
              onWorkbench={() => navigate("workbench")}
              onAgent={() => navigate("agent")}
              onProjects={() => navigate("projects")}
              onAssets={() => navigate("assets")}
              onPrompts={() => navigate("prompts")}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
