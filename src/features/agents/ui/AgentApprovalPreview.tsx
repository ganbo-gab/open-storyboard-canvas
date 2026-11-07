import { useEffect, useState } from "react";
import { FileText, Images } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { resolveAgentCanvasPlan } from "../application/agentCanvasPlanRepository";
import type { AgentCanvasPlan } from "../application/agentCanvasPlan";
import { parseProfileImport } from "@/features/channels/application/channelService";
import { useProjectStore } from "@/stores/projectStore";

const openPlanArguments = z.object({ projectId: z.string().nullable(), planId: z.string() });
const channelArguments = z.object({ profileJson: z.string(), channelId: z.string().optional() });

/** Reads the exact stored plan an approval will materialize; the redacted audit arguments only carry its id. */
export function AgentCanvasPlanPreview({ args, projectId, runId }: { args: unknown; projectId: string; runId?: string }) {
  const { t } = useTranslation();
  const parsed = openPlanArguments.safeParse(args);
  const planId = parsed.success ? parsed.data.planId : null;
  const targetProjectId = parsed.success ? parsed.data.projectId : null;
  const targetName = useProjectStore((state) => state.projects.find((project) => project.id === targetProjectId)?.name);
  const [view, setView] = useState<{ plan: AgentCanvasPlan | null; error: string }>({ plan: null, error: "" });
  useEffect(() => {
    if (!planId || !runId) return;
    let active = true;
    setView({ plan: null, error: "" });
    void resolveAgentCanvasPlan(planId, { projectId, runId }).then(
      (plan) => { if (active) setView({ plan, error: "" }); },
      (cause: unknown) => { if (active) setView({ plan: null, error: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { active = false; };
  }, [planId, projectId, runId]);
  if (!planId || !runId) return null;
  if (view.error) return <p role="alert" className="mt-3 text-xs leading-5 text-danger">{view.error}</p>;
  if (!view.plan) return <p role="status" className="mt-3 text-xs text-text-muted">{t("common.loading")}</p>;
  const { plan } = view;
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[var(--line)] bg-surface p-3">
      <div>
        <p className="text-sm font-semibold text-text-dark">{plan.title}</p>
        <p className="mt-1 text-[11px] leading-5 text-text-muted">
          {t("rework.agent.plan.summary", {
            shots: plan.shots.length,
            target: targetProjectId ? targetName ?? targetProjectId : t("rework.agent.plan.newProject"),
          })}
        </p>
      </div>
      {plan.script.trim() && (
        <details className="text-xs text-text-muted">
          <summary className="flex cursor-pointer items-center gap-1.5 rounded-sm hover:text-text-dark focus-visible:outline-2 focus-visible:outline-accent">
            <FileText className="h-3.5 w-3.5" />
            {t("rework.agent.plan.script", { count: plan.script.length })}
          </summary>
          <p className="ui-scrollbar mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-6 text-text-dark">{plan.script}</p>
        </details>
      )}
      <ol className="space-y-2" aria-label={t("rework.agent.plan.shots")}>
        {plan.shots.map((shot, index) => (
          <li key={`${index}-${shot.title}`} className="rounded-md border border-[var(--line)] px-2.5 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-text-dark">
              <Images className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{index + 1}. {shot.title}</span>
              <span className="shrink-0 text-[10px] font-normal text-text-subtle">{shot.aspectRatio} · {shot.resolution}</span>
            </div>
            <details className="mt-1 text-[11px] text-text-muted">
              <summary className="line-clamp-2 cursor-pointer leading-5 marker:content-none">{shot.prompt}</summary>
              <p className="mt-1 whitespace-pre-wrap break-words leading-5">{shot.prompt}</p>
              <p className="mt-1 break-all font-mono text-[10px] text-text-subtle">{shot.modelId}</p>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Human summary of a channel profile an approval would save; credentials are never part of it. */
export function AgentChannelProfileSummary({ args }: { args: unknown }) {
  const { t } = useTranslation();
  const parsed = channelArguments.safeParse(args);
  if (!parsed.success) return null;
  const imported = parseProfileImport(parsed.data.profileJson);
  if (!imported.ok) {
    return <p className="mt-2 text-[11px] leading-5 text-text-muted">{t("rework.agent.channel.unparsable")}</p>;
  }
  const { profile } = imported;
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-[var(--line)] bg-surface p-3 text-[11px] text-text-muted">
      <dt>{t("rework.agent.channel.name")}</dt><dd className="text-text-dark">{profile.name}</dd>
      <dt>{t("rework.agent.channel.baseUrl")}</dt><dd className="break-all font-mono">{profile.baseUrl}</dd>
      <dt>{t("rework.agent.channel.auth")}</dt><dd>{profile.auth.type}</dd>
      <dt>{t("rework.agent.channel.models")}</dt><dd className="break-words">{profile.models.map((model) => model.id).join(", ")}</dd>
      <dd className="col-span-2 mt-1 leading-5">{t("rework.agent.channel.noCredential")}</dd>
    </dl>
  );
}
