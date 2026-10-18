import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ArrowUp, FolderOpen, Plus } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import type { WorkbenchKind } from "@/features/workbench/domain/types";
import { RenameDialog } from "@/features/project/RenameDialog";

type Props = {
  onWorkbench: () => void;
  onAgent: () => void;
  onProjects: () => void;
};

const KINDS = ["image", "video", "audio"] as const;

export function StudioHome({ onWorkbench, onAgent, onProjects }: Props) {
  const { t } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const openProject = useProjectStore((state) => state.openProject);
  const createProject = useProjectStore((state) => state.createProject);
  const [naming, setNaming] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<WorkbenchKind>("image");
  const recent = [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6);

  const openWorkbench = () => {
    const text = prompt.trim();
    if (text) {
      useWorkbenchStore.getState().createConversation(text.slice(0, 24));
      useWorkbenchStore.getState().setDraft({ prompt: text, kind });
    }
    onWorkbench();
  };

  return (
    <div className="studio-home ui-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col px-6 pb-16 pt-16 sm:px-10">
        <h1 className="text-[28px] font-medium tracking-tight text-text-dark">
          {t("rework.welcome")}
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-text-muted">
          {t("rework.welcomeHint")}
        </p>
        <div className="studio-composer mt-8 p-4">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                openWorkbench();
              }
            }}
            aria-label={t("rework.prompt")}
            placeholder={t("rework.promptHint")}
            className="ui-scrollbar block min-h-24 w-full resize-none bg-transparent text-sm leading-6 text-text-dark outline-none placeholder:text-white/28"
          />
          <div className="mt-3 flex items-center gap-2">
            {KINDS.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={kind === item}
                onClick={() => setKind(item)}
                className={`h-8 rounded-full px-3 text-xs ${kind === item ? "bg-white/10 text-text-dark" : "text-text-muted hover:bg-white/6"}`}
              >
                {t(`rework.${item}`)}
              </button>
            ))}
            <button
              type="button"
              onClick={onAgent}
              className="h-8 rounded-full px-3 text-xs text-text-muted hover:bg-white/6 hover:text-text-dark"
            >
              {t("rework.agent.home")}
            </button>
            <button
              type="button"
              aria-label={t("rework.openWorkbench")}
              onClick={openWorkbench}
              className="stage-send-icon ml-auto flex h-9 w-9 items-center justify-center"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
        <section className="mt-12">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-text-dark">{t("rework.recent")}</h2>
            <button
              type="button"
              onClick={onProjects}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-dark"
            >
              {t("rework.all")}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <button
              type="button"
              onClick={() => setNaming(true)}
              className="studio-project-card flex min-h-24 items-center gap-4 rounded-2xl border p-4 text-left"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-black">
                <Plus className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm text-text-dark">{t("rework.newCanvas")}</span>
                <span className="mt-1 block text-xs text-text-muted">{t("rework.canvasHint")}</span>
              </span>
            </button>
            {recent.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => void openProject(project.id)}
                className="studio-project-card flex min-h-24 items-center gap-4 rounded-2xl border p-4 text-left"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/6 text-text-muted">
                  <FolderOpen className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text-dark">{project.name}</span>
                  <span className="mt-1 block text-xs text-text-muted">
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <RenameDialog
        isOpen={naming}
        onClose={() => setNaming(false)}
        onConfirm={(name) => {
          createProject(name);
          setNaming(false);
        }}
        title={t("rework.newCanvas")}
        defaultValue=""
      />
    </div>
  );
}
