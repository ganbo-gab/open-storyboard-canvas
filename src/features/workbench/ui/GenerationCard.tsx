import { useEffect, useState } from "react";
import {
  Copy,
  Download,
  Eye,
  Info,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  SendToBack,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { canDeleteWorkbenchTask, isWorkbenchTaskRunning, useWorkbenchStore } from "../store/workbenchStore";
import type { WorkbenchResult, WorkbenchTask } from "../domain/types";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { MenuItem, MenuSurface, UiButton, UiConfirm, UiIconButton, anchorBelow, type MenuAnchor } from "@/components/ui";
import {
  AssetMedia,
  downloadAssetSource,
} from "@/features/assets/ui/AssetMedia";
import { ReferenceUploadAction } from "@/features/channels/ui/ReferenceUploadAction";
import { writeStudioMediaDrag } from "@/features/studio/mediaDrag";
import { MediaImportDialog } from "@/features/studio/MediaImportDialog";
import { openMediaViewer, closeMediaViewer, type MediaViewerItem } from '@/features/viewer/viewerStore';
import { openGenerationDetails } from '@/features/library/ui/GenerationDetailsDialog';
import { ComfyRecoveryControl } from './ComfyRecoveryControl';
import { CredentialRecoveryControl } from './CredentialRecoveryControl';
import { workbenchTaskStatusLabel } from "../application/taskHealth";
import { workbenchErrorText } from "./workbenchErrorText";

type Props = { task: WorkbenchTask };
export function GenerationCard({ task }: Props) {
  const { t, i18n } = useTranslation();
  const [time, setTime] = useState(Date.now());
  const [sendIndex, setSendIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; index: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const deletable = canDeleteWorkbenchTask(task);
  const showError = (cause: unknown) => setError(workbenchErrorText(t, (key) => i18n.exists(key), cause));
  const running = isWorkbenchTaskRunning(task);
  const stalled = task.failure?.code === "task.stalled";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTime(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  /** Explicit paid action: a new task from the same input; the original stays as it is. */
  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true); setError(""); setNotice("");
    try { await useWorkbenchStore.getState().regenerate(task.id); }
    catch (cause) { showError(cause); }
    finally { setRegenerating(false); }
  };
  const useAsReference = (result: WorkbenchResult) => {
    const kind = result.kind;
    if (kind !== "image" && kind !== "video" && kind !== "audio") return;
    try {
      useWorkbenchStore.getState().addReferences([{ id: crypto.randomUUID(), kind, source: result.source, name: task.input.prompt.slice(0, 40) }]);
      setError(''); setNotice(t('ui.workbench.referenceAdded')); return true;
    } catch (cause) { showError(cause); return false; }
  };
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice(t("rework.copied")), showError);
  };
  const viewResult = (selected: WorkbenchResult) => {
    const items: MediaViewerItem[] = task.results.flatMap((result, index) => {
      if (result.kind !== 'image' && result.kind !== 'video' && result.kind !== 'audio') return [];
      return [{ id: `${task.id}:${index}`, kind: result.kind, source: result.source, title: task.input.prompt.slice(0, 60), prompt: task.input.prompt,
        facts: [{ label: t('ui.viewer.model'), value: task.input.model }],
        actions: [
          { id: 'reference', label: t('rework.useReference'), icon: <ImagePlus />, run: () => { if (useAsReference(result)) closeMediaViewer(); else throw new Error(t('ui.workbench.referenceNotAdded')); } },
          { id: 'canvas', label: t('rework.sendToCanvas'), icon: <SendToBack />, run: () => { closeMediaViewer(); setSendIndex(index); } },
          { id: 'edit', label: t('rework.editAgain'), icon: <RefreshCw />, run: () => { const { conversationId: _id, ...draft } = task.input; useWorkbenchStore.getState().setDraft(draft); closeMediaViewer(); } },
        ], primaryActions: [{ id: 'regenerate', label: t('rework.regenerate'), run: regenerate }],
      }];
    });
    openMediaViewer(items, Math.max(0, items.findIndex((item) => item.source === selected.source)));
  };
  const menuResult = menu ? task.results[menu.index] : undefined;
  return (
    <article
      id={`generation-${task.id}`}
      className="studio-generation scroll-mt-8 rounded-2xl border border-[var(--line)] bg-surface p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--hover)] text-[10px] font-medium text-text-muted">
          {t(`rework.${task.input.kind}`).slice(0, 1)}
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-6 text-text-dark">
          {task.input.prompt}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        <span>{t(`rework.taskDrawer.status.${workbenchTaskStatusLabel(task)}`)}</span>
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
        <button type="button" className="inline-flex items-center gap-1 text-text-muted hover:text-text" onClick={() => openGenerationDetails({ taskId: task.id, jobId: task.jobId })}><Info size={12} />{t('ui.details.title')}</button>
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
          className="mt-5 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--field-bg)] p-5 text-xs text-text-muted"
        >
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {t("rework.generating")}
          <span className="ml-auto font-mono tabular-nums">
            {(Math.max(0, time - (task.tracking?.startedAt ?? task.createdAt)) / 1000).toFixed(1)}s
          </span>
          <UiIconButton
            type="button"
            title={t("rework.stop")}
            aria-label={t("rework.stop")}
            onClick={() => useWorkbenchStore.getState().cancelWaiting(task.id)}
            variant="ghost"
          >
            <Square className="h-3.5 w-3.5" />
          </UiIconButton>
        </div>
      )}
      {task.waitingCanceled && (task.jobId || stalled) && (stalled || !task.failure) && task.status !== "succeeded" && task.status !== "failed" && task.status !== "canceled" && task.job?.error_category !== "credential" && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--field-bg)] p-4 text-xs text-text-muted">
          <span className="flex-1">{t(stalled ? "rework.taskDrawer.stalledHint" : "rework.pausedHint")}</span>
          {task.jobId && <UiButton
            type="button"
            onClick={() => {
              void useWorkbenchStore
                .getState()
                .resume(task.id)
                .catch((cause: unknown) => setError(String(cause)));
            }}
            variant="secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("rework.resumeChecking")}
          </UiButton>}
        </div>
      )}
      {((task.failure && !stalled) || task.status === "unknown") && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-warning/20 bg-warning/5 p-4 text-xs leading-6 text-text-dark"
        >
          {task.failure?.code === "reference.needsPublicUrl" && task.failure.slotKey
            ? t("reference.needsPublicUrl", { slotKey: task.failure.slotKey })
            : (task.failure?.message ?? t("rework.unknown"))}
          {task.failure?.code === "reference.needsPublicUrl" && task.failure.slotKey && (
            <ReferenceUploadAction
              className="mt-2 items-start"
              failure={{ slotKey: task.failure.slotKey, slotKind: task.failure.slotKind }}
              slotSourceCount={task.input.referenceSlots?.[task.failure.slotKey]?.length ?? 0}
              onUploadConfirmed={async (confirmation) => {
                await useWorkbenchStore.getState().retryWithHostedReference(task.id, confirmation);
              }}
            />
          )}
          {task.job?.error_category === 'credential' && task.jobId && <CredentialRecoveryControl jobId={task.jobId} canQuery={Boolean(task.job.resumable)} onAuthorized={() => useWorkbenchStore.getState().recoverResult(task.id)} />}
          {task.job?.error_category !== 'credential' && (task.jobId ||
            (task.status === "recoverable_wait" &&
              task.results.length > 0)) && (
            <UiButton
              type="button"
              onClick={() => {
                setError("");
                void useWorkbenchStore
                  .getState()
                  .recoverResult(task.id)
                  .catch((cause: unknown) => setError(String(cause)));
              }}
              variant="ghost"
              className="mt-2"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("rework.retryQuery")}
            </UiButton>
          )}
        </div>
      )}
      {running && task.job?.progress_transport && <div className="mt-3 space-y-1 text-xs text-text-muted">
        <span>{task.job.progress_transport === 'websocket' ? t('ui.workbench.liveProgress') : t('ui.workbench.pollingProgress')}{task.job.current_node ? ` · ${task.job.current_node}` : ''}{task.job.step !== undefined ? ` · ${task.job.step}/${task.job.total_steps ?? '?'}` : ''}</span>
        {task.job.progress_transport === 'websocket' && task.job.progress !== undefined && <progress className="block h-1 w-full accent-accent" max={1} value={task.job.progress} />}
      </div>}
      {task.jobId?.startsWith('custom-local-comfy-v2-') && ['unknown', 'recoverable_wait'].includes(task.status) && <ComfyRecoveryControl jobId={task.jobId} onRecovered={() => useWorkbenchStore.getState().poll(task.id)} />}
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
                draggable={result.kind !== "text"}
                onDragStart={(event) => {
                  if (result.kind === "text") return;
                  writeStudioMediaDrag(event.dataTransfer, { kind: "workbench-result", taskId: task.id, resultIndex: index });
                }}
                title={result.kind === "text" ? undefined : t("rework.mediaDrop.dragHint")}
                className={`${result.kind === "text" ? "sm:col-span-2" : "cursor-grab active:cursor-grabbing"} min-w-0 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--field-bg)]`}
              >
                {result.kind === "text" ? (
                  <div className="ui-scrollbar max-h-96 overflow-auto whitespace-pre-wrap p-4 text-sm leading-7 text-text-dark">
                    {result.source}
                  </div>
                ) : result.kind === "image" ? (
                  <button
                    type="button"
                    onClick={() => viewResult(result)}
                    className="studio-card w-full transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent"
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
                <div className="flex flex-wrap items-center gap-1 border-t border-[var(--line)] p-2">
                  {url && (
                    <UiIconButton
                      type="button"
                      onClick={() => void downloadAssetSource(result.source).catch(showError)}
                      variant="ghost"
                      aria-label={t("rework.download")}
                      title={t("rework.download")}
                    >
                      <Download className="h-4 w-4" />
                    </UiIconButton>
                  )}
                  {(result.kind === "image" || result.kind === "video" || result.kind === "audio") && (
                    <UiIconButton
                      type="button"
                      title={t("rework.useReference")}
                      aria-label={t("rework.useReference")}
                      onClick={() => useAsReference(result)}
                      variant="ghost"
                    >
                      <ImagePlus className="h-4 w-4" />
                    </UiIconButton>
                  )}
                  <UiIconButton
                    type="button"
                    title={t("rework.regenerate")}
                    aria-label={t("rework.regenerate")}
                    disabled={regenerating}
                    onClick={() => void regenerate()}
                    variant="ghost"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </UiIconButton>
                  {result.kind !== "text" && (
                    <UiIconButton
                      type="button"
                      title={t("rework.sendToCanvas")}
                      aria-label={t("rework.sendToCanvas")}
                      onClick={() => setSendIndex(index)}
                      variant="ghost"
                    >
                      <SendToBack className="h-4 w-4" />
                    </UiIconButton>
                  )}
                  <UiIconButton
                    type="button"
                    title={t("rework.more")}
                    aria-label={t("rework.more")}
                    aria-haspopup="menu"
                    onClick={(event) => {
                      setMenu(menu?.index === index ? null : { anchor: anchorBelow(event.currentTarget), index });
                    }}
                    variant="ghost"
                    className="ml-auto"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </UiIconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {task.jobId && task.status === 'succeeded' && <UiButton type="button" variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => { void useWorkbenchStore.getState().recoverResult(task.id).catch(showError); }}>{t('ui.workbench.retrieveResults')}</UiButton>}
        <UiButton
          type="button"
          onClick={() => {
            const { conversationId: _conversationId, ...draft } = task.input;
            useWorkbenchStore.getState().setDraft(draft);
          }}
          variant="ghost"
          size="sm"
        >
          {t("rework.editAgain")}
        </UiButton>
        <UiButton type="button" variant="ghost" size="sm" loading={regenerating} icon={<RotateCcw />} onClick={() => void regenerate()}>
          {t("rework.regenerate")}
        </UiButton>
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          icon={<Trash2 />}
          disabled={!deletable}
          title={deletable ? undefined : t("rework.validation.workbench.taskActive")}
          onClick={() => setConfirmDelete(true)}
        >
          {t("rework.delete")}
        </UiButton>
        {notice && (
          <span role="status" className="ml-auto text-xs text-success">
            {notice}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      {menu && menuResult && (
        <MenuSurface anchor={menu.anchor} onClose={() => setMenu(null)} width={220} label={t("rework.more")}>
          {(menuResult.kind === "image" || menuResult.kind === "video" || menuResult.kind === "audio") && (
            <MenuItem icon={<Eye />} label={t("rework.view")} onClick={() => { setMenu(null); viewResult(menuResult); }} />
          )}
          {menuResult.kind !== "text" && (
            <MenuItem icon={<Download />} label={t("rework.download")} onClick={() => { setMenu(null); void downloadAssetSource(menuResult.source).catch(showError); }} />
          )}
          {(menuResult.kind === "image" || menuResult.kind === "video" || menuResult.kind === "audio") && (
            <MenuItem icon={<ImagePlus />} label={t("rework.useReference")} onClick={() => { setMenu(null); useAsReference(menuResult); }} />
          )}
          {menuResult.kind !== "text" && (
            <MenuItem icon={<SendToBack />} label={t("rework.sendToCanvas")} onClick={() => { setMenu(null); setSendIndex(menu.index); }} />
          )}
          {menuResult.kind === "text" && (
            <MenuItem icon={<Copy />} label={t("rework.copyText")} onClick={() => { setMenu(null); copy(menuResult.source); }} />
          )}
          <MenuItem icon={<Copy />} label={t("rework.copyPrompt")} onClick={() => { setMenu(null); copy(task.input.prompt); }} />
          <MenuItem icon={<RotateCcw />} label={t("rework.regenerate")} disabled={regenerating} onClick={() => { setMenu(null); void regenerate(); }} />
        </MenuSurface>
      )}
      {sendIndex !== null && (
        <MediaImportDialog payload={{ kind: "workbench-result", taskId: task.id, resultIndex: sendIndex }} onClose={() => setSendIndex(null)} />
      )}
      <UiConfirm
        isOpen={confirmDelete}
        title={t("rework.deleteTaskTitle")}
        description={t("rework.deleteTaskConfirm")}
        confirmLabel={t("rework.delete")}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          try { useWorkbenchStore.getState().deleteTask(task.id); }
          catch (cause) { showError(cause); }
        }}
      />

    </article>
  );
}
