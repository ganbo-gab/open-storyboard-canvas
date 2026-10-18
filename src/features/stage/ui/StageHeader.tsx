import {
  Aperture,
  ArrowLeft,
  Clapperboard,
  Eraser,
  PanelRight,
  Save,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

type Props = {
  mode: "director" | "previs";
  dirty: boolean;
  agentOpen: boolean;
  canRecord: boolean;
  onBack: () => void;
  onMode: (mode: "director" | "previs") => void;
  onSave: () => void;
  onCapture: () => void;
  onRecord: () => void;
  onImport: () => void;
  onUndo: () => void;
  onSidebar: () => void;
  onAgent: () => void;
  onClearPanorama?: () => void;
};
export function StageHeader({
  mode,
  dirty,
  agentOpen,
  canRecord,
  onBack,
  onMode,
  onSave,
  onCapture,
  onRecord,
  onImport,
  onUndo,
  onSidebar,
  onAgent,
  onClearPanorama,
}: Props) {
  const { t } = useTranslation();
  return (
    <header className="absolute inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-3 border-b border-white/10 bg-[#151618]/95 px-3 backdrop-blur-lg">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          title={t("titleBar.back")}
          aria-label={t("common.close")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-white/60 hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="hidden min-w-0 sm:block">
          <h1 className="text-sm font-semibold text-white">
            {t("directorStudio.title")}
          </h1>
          <span
            className={`text-[10px] ${dirty ? "text-amber-300/80" : "text-white/40"}`}
          >
            {t(dirty ? "directorStudio.unsaved" : "directorStudio.saved")}
          </span>
        </div>
        <div
          className="flex shrink-0 rounded-lg border border-white/10 bg-black/20 p-1"
          role="group"
          aria-label={t("directorStudio.studioMode.label")}
        >
          {(["director", "previs"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => onMode(value)}
              className={`h-8 rounded-md px-3 text-xs transition-colors ${mode === value ? "bg-white/12 font-medium text-white" : "text-white/45 hover:text-white"}`}
            >
              {t(`directorStudio.studioMode.${value}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onUndo}
          aria-label={t("rework.canvas.undo")}
          title={t("rework.canvas.undo")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCapture}
          aria-label={t("directorStudio.toolbar.screenshot")}
          title={t("directorStudio.toolbar.screenshot")}
          className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-2.5 text-xs text-white/75 hover:bg-white/5"
        >
          <Aperture className="h-4 w-4" />
          <span className="hidden md:inline">
            {t("directorStudio.toolbar.screenshot")}
          </span>
        </button>
        {mode === "previs" && (
          <button
            type="button"
            onClick={onRecord}
            disabled={!canRecord}
            aria-label={t("directorStudio.previs.record")}
            title={t(
              canRecord
                ? "directorStudio.previs.record"
                : "directorStudio.motion.export.needsCamera",
            )}
            className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-2.5 text-xs text-white/75 hover:bg-white/5 disabled:opacity-30"
          >
            <Clapperboard className="h-4 w-4" />
            <span className="hidden md:inline">
              {t("directorStudio.previs.record")}
            </span>
          </button>
        )}
        {onClearPanorama && (
          <button
            type="button"
            onClick={onClearPanorama}
            aria-label={t("directorStudio.clearPanorama")}
            title={t("directorStudio.clearPanorama")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-red-300/70 hover:bg-red-500/10"
          >
            <Eraser className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onImport}
          aria-label={t("directorStudio.panoramaImport")}
          title={t("directorStudio.panoramaImport")}
          className="hidden h-9 w-9 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white sm:flex"
        >
          <Upload className="h-4 w-4" />
        </button>
        {mode === "previs" && (
          <button
            type="button"
            onClick={onSidebar}
            aria-label={t("directorStudio.previs.toggleSidebar")}
            title={t("directorStudio.previs.toggleSidebar")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onAgent}
          aria-pressed={agentOpen}
          aria-label={t("rework.agent.stage")}
          title={t("rework.agent.stage")}
          className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs ${agentOpen ? "border-accent/50 bg-accent/15 text-white" : "border-white/10 text-white/75 hover:bg-white/5"}`}
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden lg:inline">{t("rework.agent.stage")}</span>
        </button>
        <button
          type="button"
          onClick={onSave}
          aria-label={t("directorStudio.saveProject")}
          title={t("directorStudio.saveProject")}
          className="flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-xs font-medium text-black hover:bg-white/90"
        >
          <Save className="h-4 w-4" />
          <span className="hidden lg:inline">
            {t("directorStudio.saveProject")}
          </span>
        </button>
      </div>
    </header>
  );
}
