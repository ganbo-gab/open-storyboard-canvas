import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Workflow } from "lucide-react";
import type { ProjectSummary } from "@/stores/projectStore";
import type { AssetRecord } from "@/features/assets/application/assetCatalog";
import { AssetMedia } from "@/features/assets/ui/AssetMedia";

/** First image asset per project, in catalog order (newest first). */
export function projectCoverMap(assets: readonly AssetRecord[] | null): Map<string, AssetRecord> {
  const map = new Map<string, AssetRecord>();
  for (const asset of assets ?? []) {
    if (asset.kind === "image" && asset.projectId && !map.has(asset.projectId)) map.set(asset.projectId, asset);
  }
  return map;
}

type Props = {
  project: ProjectSummary;
  cover?: AssetRecord;
  onOpen: () => void;
  disabled?: boolean;
  /** Hover actions in the cover's top-right corner. They must stop propagation themselves. */
  actions?: ReactNode;
};

export function ProjectCard({ project, cover, onOpen, disabled, actions }: Props) {
  const { t } = useTranslation();
  return (
    <div className="studio-card-host relative">
      <button
        type="button"
        className="studio-card w-full"
        onClick={onOpen}
        disabled={disabled}
        title={project.name}
        aria-label={`${t("project.open")}: ${project.name}`}
      >
        <span className="studio-card__media block aspect-[16/10]" data-empty={cover ? undefined : ""}>
          {cover ? (
            <AssetMedia source={cover.previewUrl || cover.source} kind="image" alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center">
              <Workflow className="h-6 w-6 opacity-50" />
            </span>
          )}
        </span>
        <span className="min-w-0 px-0.5">
          <span className="block truncate text-[13.5px] font-medium text-text-dark">{project.name}</span>
          <span className="mt-0.5 block text-xs text-text-subtle">
            {new Date(project.updatedAt).toLocaleDateString()} · {t("rework.nodeCount", { count: project.nodeCount })}
          </span>
        </span>
      </button>
      {actions && <div className="studio-card__actions">{actions}</div>}
    </div>
  );
}
