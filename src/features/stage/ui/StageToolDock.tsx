import { useState } from "react";
import { MoreHorizontal, Move3d, Rotate3d, Scale3d } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DirectorStudioTransformMode } from "@/features/canvas/domain/canvasNodes";

export interface StageToolSpec {
  key: string;
  label: string;
  title: string;
  icon: LucideIcon;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}
type Props = {
  tools: StageToolSpec[];
  onAnchor: (key: string, element: HTMLElement | null) => void;
  transformMode: DirectorStudioTransformMode | null;
  canTransform: boolean;
  onTransform: (mode: DirectorStudioTransformMode) => void;
};
const primary: Record<string, true> = {
  model: true,
  defaultPedestrian: true,
  transform: true,
  cameraPreset: true,
  lighting: true,
  screenshot: true,
};
export function StageToolDock({
  tools,
  onAnchor,
  transformMode,
  canTransform,
  onTransform,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="director-studio-tool-dock pointer-events-auto max-w-[calc(100%-32px)] rounded-2xl border border-white/12 bg-[#1a1b1d]/95 p-2 shadow-2xl backdrop-blur-lg">
      <div className="flex flex-wrap items-center justify-center gap-1">
        {tools
          .filter((tool) => primary[tool.key])
          .map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.key}
                ref={(element) => onAnchor(tool.key, element)}
                type="button"
                onClick={tool.onClick}
                disabled={tool.disabled}
                title={tool.title}
                aria-label={tool.title}
                aria-pressed={tool.active ?? undefined}
                className={`flex h-12 min-w-16 flex-col items-center justify-center gap-1 rounded-xl px-3 text-[10px] transition-colors ${tool.active ? "bg-accent/15 text-accent" : "text-white/65 hover:bg-white/5 hover:text-white"} disabled:opacity-30`}
              >
                <Icon className="h-4 w-4" />
                <span>{tool.label}</span>
              </button>
            );
          })}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          title={t("rework.more")}
          className="flex h-12 min-w-14 flex-col items-center justify-center gap-1 rounded-xl px-3 text-[10px] text-white/55 hover:bg-white/5"
        >
          <MoreHorizontal className="h-4 w-4" />
          {t("rework.more")}
        </button>
      </div>
      {canTransform && (
        <div className="mt-1 flex items-center justify-center gap-1 border-t border-white/8 pt-2">
          {[
            { mode: "move" as const, icon: Move3d, key: "G" },
            { mode: "rotate" as const, icon: Rotate3d, key: "R" },
            { mode: "scale" as const, icon: Scale3d, key: "T" },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.mode}
                type="button"
                onClick={() => onTransform(item.mode)}
                aria-pressed={transformMode === item.mode}
                className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[11px] ${transformMode === item.mode ? "bg-accent/15 text-accent" : "text-white/50 hover:bg-white/5"}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(`directorStudio.transform.${item.mode}`)}
                <kbd className="text-[9px] opacity-50">{item.key}</kbd>
              </button>
            );
          })}
        </div>
      )}
      {expanded && (
        <div className="mt-2 grid grid-cols-3 gap-1 border-t border-white/8 pt-2 sm:grid-cols-4">
          {tools
            .filter((tool) => !primary[tool.key])
            .map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.key}
                  ref={(element) => onAnchor(tool.key, element)}
                  type="button"
                  onClick={tool.onClick}
                  disabled={tool.disabled}
                  title={tool.title}
                  aria-label={tool.title}
                  aria-pressed={tool.active ?? undefined}
                  className={`flex h-10 items-center gap-2 rounded-lg px-3 text-[11px] ${tool.active ? "bg-accent/15 text-accent" : "text-white/60 hover:bg-white/5"} disabled:opacity-30`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tool.label}</span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
