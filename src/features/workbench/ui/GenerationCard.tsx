import { useEffect, useState } from "react";
import {
  Download,
  ImagePlus,
  Loader2,
  RefreshCw,
  SendToBack,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { WorkbenchResult, WorkbenchTask } from "../domain/types";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useProjectStore } from "@/stores/projectStore";
import { UiModal } from "@/components/ui";
import {
  AssetMedia,
  downloadAssetSource,
} from "@/features/assets/ui/AssetMedia";

type Props = { task: WorkbenchTask };
export function GenerationCard({ task }: Props) {
  const { t } = useTranslation();
  const [time, setTime] = useState(Date.now());
  const [viewer, setViewer] = useState<WorkbenchResult | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const projects = useProjectStore((state) => state.projects);
  const running =
    ["queued", "submitting", "running", "materializing"].includes(
      task.status,
    ) && !task.waitingCanceled;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTime(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  return (
    <article
      id={`generation-${task.id}`}
      className="studio-generation scroll-mt-8 rounded-2xl border border-border-dark bg-surface-dark/45 p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-text-dark/5 text-[10px] font-medium text-text-muted">
          {t(`rework.${task.input.kind}`).slice(0, 1)}
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-6 text-text-dark">
          {task.input.prompt}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        <span className="max-w-64 truncate">
          {task.input.model.split(":").slice(2).join(":") || task.input.model}
        </span>
        {task.input.config?.aspectRatio && (
          <span>{task.input.config.aspectRatio}</span>
        )}
        {task.input.config?.size && <span>{task.input.config.size}</span>}
        {task.input.config?.seconds && (
          <span>{task.input.config.seconds}s</span>
        )}
        <time>
          {new Date(task.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {running && (
        <div
          role="status"
          className="mt-5 flex items-center gap-3 rounded-xl border border-border-dark bg-bg-dark/50 p-5 text-xs text-text-muted"
        >
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {t("rework.generating")}
          <span className="ml-auto font-mono tabular-nums">
            {((time - task.createdAt) / 1000).toFixed(1)}s
          </span>
          <button
            type="button"
            title={t("rework.stop")}
            aria-label={t("rework.stop")}
            onClick={() => useWorkbenchStore.getState().cancelWaiting(task.id)}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-dark"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {task.waitingCanceled && task.jobId && task.status !== "succeeded" && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-border-dark bg-bg-dark/40 p-4 text-xs text-text-muted">
          <span className="flex-1">{t("rework.pausedHint")}</span>
          <button
            type="button"
            onClick={() => {
              void useWorkbenchStore
                .getState()
                .resume(task.id)
                .catch((cause: unknown) => setError(String(cause)));
            }}
            className="flex items-center gap-2 rounded-lg border border-border-dark px-3 py-2 text-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("rework.resumeChecking")}
          </button>
        </div>
      )}
      {(task.failure || task.status === "unknown") && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-6 text-text-dark"
        >
          {task.failure?.message ?? t("rework.unknown")}
          {(task.jobId ||
            (task.status === "recoverable_wait" &&
              task.results.length > 0)) && (
            <button
              type="button"
              onClick={() => {
                setError("");
                void useWorkbenchStore
                  .getState()
                  .recoverResult(task.id)
                  .catch((cause: unknown) => setError(String(cause)));
              }}
              className="mt-2 flex items-center gap-2 text-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("rework.retryQuery")}
            </button>
          )}
        </div>
      )}
      {!!task.results.length && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {task.results.map((result, index) => {
            const url =
              result.kind === "text"
                ? ""
                : resolveImageDisplayUrl(result.source);
            return (
              <div
                key={`${index}-${result.assetId ?? ""}`}
                className={`${result.kind === "text" ? "sm:col-span-2" : ""} min-w-0 overflow-hidden rounded-xl border border-border-dark bg-bg-dark/40`}
              >
                {result.kind === "text" ? (
                  <div className="ui-scrollbar max-h-96 overflow-auto whitespace-pre-wrap p-4 text-sm leading-7 text-text-dark">
                    {result.source}
                  </div>
                ) : result.kind === "image" ? (
                  <button
                    type="button"
                    onClick={() => setViewer(result)}
                    className="block w-full"
                    aria-label={t("rework.view")}
                  >
                    <AssetMedia
                      source={result.source}
                      kind="image"
                      alt={task.input.prompt}
                      className="max-h-80 w-full object-contain"
                    />
                  </button>
                ) : result.kind === "video" ? (
                  <AssetMedia
                    source={result.source}
                    kind="video"
                    controls
                    className="max-h-80 w-full"
                  />
                ) : (
                  <AssetMedia
                    source={result.source}
                    kind="audio"
                    controls
                    className="w-full p-3"
                  />
                )}
                <div className="flex flex-wrap items-center gap-1 border-t border-border-dark p-2">
                  {url && (
                    <button
                      type="button"
                      onClick={() =>
                        void downloadAssetSource(result.source).catch(
                          (cause: unknown) => setError(String(cause)),
                        )
                      }
                      className="rounded-lg p-2 text-text-muted hover:bg-surface-dark hover:text-text-dark"
                      title={t("rework.download")}
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  )}
                  {result.kind !== "text" && (
                    <button
                      type="button"
                      title={t("rework.useReference")}
                      onClick={() => {
                        const state = useWorkbenchStore.getState();
                        state.setDraft({
                          references: [
                            ...(state.draft.references ?? []),
                            {
                              id: crypto.randomUUID(),
                              kind: result.kind as "image" | "video" | "audio",
                              source: result.source,
                              name: task.input.prompt.slice(0, 40),
                            },
                          ],
                        });
                      }}
                      className="rounded-lg p-2 text-text-muted hover:bg-surface-dark hover:text-text-dark"
                    >
                      <ImagePlus className="h-4 w-4" />
                    </button>
                  )}
                  <select
                    aria-label={t("rework.chooseProject")}
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    className="h-8 min-w-0 max-w-40 rounded-lg bg-transparent px-1 text-[11px] text-text-muted"
                  >
                    <option value="">{t("rework.chooseProject")}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!target}
                    title={t("rework.sendToCanvas")}
                    aria-label={t("rework.sendToCanvas")}
                    onClick={async () => {
                      setError("");
                      try {
                        await useWorkbenchStore
                          .getState()
                          .importResult(task.id, target, index);
                        setNotice(t("rework.sent"));
                      } catch (cause) {
                        setError(String(cause));
                      }
                    }}
                    className="rounded-lg p-2 text-text-muted hover:bg-surface-dark hover:text-accent disabled:opacity-30"
                  >
                    <SendToBack className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex justify-between">
        <button
          type="button"
          onClick={() => {
            const { conversationId: _conversationId, ...draft } = task.input;
            useWorkbenchStore.getState().setDraft(draft);
          }}
          className="rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-bg-dark hover:text-text-dark"
        >
          {t("rework.editAgain")}
        </button>
        {notice && (
          <span role="status" className="text-xs text-emerald-500">
            {notice}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
      <UiModal
        isOpen={!!viewer}
        onClose={() => setViewer(null)}
        title={t("rework.view")}
        widthClassName="w-[min(1100px,calc(100vw-2rem))]"
      >
        {viewer && (
          <AssetMedia
            source={viewer.source}
            kind="image"
            alt={task.input.prompt}
            className="max-h-[75vh] w-full object-contain"
          />
        )}
      </UiModal>
    </article>
  );
}
