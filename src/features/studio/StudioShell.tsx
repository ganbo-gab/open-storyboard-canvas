import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Clapperboard,
  FolderKanban,
  Home,
  Images,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/projectStore";
import { ProjectManager } from "@/features/project/ProjectManager";
import { StudioHome } from "./StudioHome";
import "./studio.css";
import "./stage.css";

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

type View =
  | "home"
  | "projects"
  | "canvas"
  | "workbench"
  | "assets"
  | "prompts"
  | "agent";
type Props = { children: ReactNode; onSettings: () => void };
const navigation = [
  { id: "home", icon: Home, label: "home" },
  { id: "workbench", icon: Clapperboard, label: "workbench" },
  { id: "projects", icon: FolderKanban, label: "projects" },
  { id: "assets", icon: Images, label: "assets" },
  { id: "prompts", icon: BookOpen, label: "prompts" },
  { id: "agent", icon: Sparkles, label: "agent.home" },
] as const;

export function StudioShell({ children, onSettings }: Props) {
  const { t } = useTranslation();
  const projectId = useProjectStore((state) => state.currentProjectId);
  const closeProject = useProjectStore((state) => state.closeProject);
  const [view, setView] = useState<View>("home");
  const [collapsed, setCollapsed] = useState(false);
  const compact = collapsed || !!projectId;
  useEffect(() => {
    if (projectId) setView("canvas");
    else setView((current) => (current === "canvas" ? "home" : current));
  }, [projectId]);
  const navigate = (next: View) => {
    if (projectId) closeProject();
    setView(next);
  };
  const onCanvas = view === "canvas" && !!projectId;
  return (
    <div className="studio-shell flex h-full min-h-0 min-w-0 bg-bg-dark">
      {!onCanvas && (
      <aside
        className={`studio-navigation flex shrink-0 flex-col border-r border-border-dark ${compact ? "w-16" : "w-56 max-[760px]:w-16"}`}
      >
        <button
          type="button"
          title={t("rework.home")}
          onClick={() => navigate("home")}
          className="flex h-16 shrink-0 items-center gap-3 overflow-hidden px-4 text-text-dark"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/8 text-text-dark">
            <Workflow className="h-4 w-4" />
          </span>
          {!compact && (
            <span className="whitespace-nowrap text-sm font-semibold max-[760px]:hidden">
              {t("rework.brand")}
            </span>
          )}
        </button>
        <nav
          aria-label={t("rework.brand")}
          className="mt-3 flex-1 space-y-1 px-2"
        >
          {navigation.map((item) => {
            const active =
              view === item.id || (view === "canvas" && item.id === "projects");
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                title={t(`rework.${item.label}`)}
                aria-label={t(`rework.${item.label}`)}
                aria-current={active ? "page" : undefined}
                className={`studio-nav-item flex h-11 w-full items-center gap-3 overflow-hidden rounded-xl px-3 text-sm transition-colors ${active ? "bg-text-dark/7 font-medium text-text-dark" : "text-text-muted hover:bg-text-dark/4 hover:text-text-dark"}`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {!compact && (
                  <span className="whitespace-nowrap max-[760px]:hidden">
                    {t(`rework.${item.label}`)}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-border-dark p-2">
          <button
            type="button"
            onClick={onSettings}
            title={t("rework.settings")}
            aria-label={t("rework.settings")}
            className="flex h-11 w-full items-center gap-3 overflow-hidden rounded-xl px-3 text-sm text-text-muted hover:bg-text-dark/4 hover:text-text-dark"
          >
            <Settings2 className="h-[18px] w-[18px] shrink-0" />
            {!compact && (
              <span className="whitespace-nowrap max-[760px]:hidden">
                {t("rework.settings")}
              </span>
            )}
          </button>
          {!projectId && (
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              title={t(compact ? "rework.expand" : "rework.collapse")}
              aria-label={t(compact ? "rework.expand" : "rework.collapse")}
              className="hidden h-9 w-full items-center gap-3 rounded-lg px-3 text-text-muted hover:text-text-dark min-[760px]:flex"
            >
              {compact ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" />
                  <span className="text-[11px]">{t("rework.collapse")}</span>
                </>
              )}
            </button>
          )}
        </div>
      </aside>
      )}
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
          ) : view === "prompts" ? (
            <PromptLibrary />
          ) : view === "agent" ? (
            <ScopedAgentPanel scope="home" onSettings={onSettings} />
          ) : (
            <StudioHome
              onWorkbench={() => navigate("workbench")}
              onAgent={() => navigate("agent")}
              onProjects={() => navigate("projects")}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
