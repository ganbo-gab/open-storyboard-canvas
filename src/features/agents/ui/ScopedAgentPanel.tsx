import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowUp,
  Check,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getScopedAgentSession } from "../application/scopedAgentSession";
import { useChatModelCatalog } from "@/features/canvas/application/chatModelCatalog";
import type { AgentTurnMediaInput } from "@/features/canvas/agent/domain/agentModel";
import { useProjectStore } from "@/stores/projectStore";
import {
  saveAsset,
  getAssetPortableSource,
} from "@/features/assets/application/assetCatalog";

type Props = {
  scope: "home" | "stage";
  projectId?: string;
  onSettings?: () => void;
  compact?: boolean;
};
export function ScopedAgentPanel({
  scope,
  projectId,
  onSettings,
  compact = false,
}: Props) {
  const { t } = useTranslation();
  const activeProjectId = useProjectStore((state) => state.currentProjectId);
  const effectiveProjectId =
    scope === "home" ? undefined : (projectId ?? activeProjectId ?? undefined);
  const session = useMemo(
    () => getScopedAgentSession({ scope, projectId: effectiveProjectId }),
    [scope, effectiveProjectId],
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const catalog = useChatModelCatalog();
  const models = catalog.filter((model) => model.usable && model.supportsTools);
  const [modelId, setModelId] = useState("");
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [media, setMedia] = useState<AgentTurnMediaInput[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const running = state.status === "running";
  const cancelable = running || state.status === "awaiting-approval";
  useEffect(() => {
    const snapshot = session.getSnapshot();
    if (!snapshot.sessionId && snapshot.status === "idle") {
      const sessions = session.listSessions();
      if (sessions[0]) {
        try {
          session.loadSession(sessions[0].id);
        } catch (cause) {
          setError(String(cause));
        }
      }
    }
  }, [session]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state.messages, state.liveText, state.approvals]);
  const send = async () => {
    if (!model || !message.trim() || running || state.approvals.length) return;
    setError("");
    const text = message;
    setMessage("");
    try {
      const portableMedia = await Promise.all(
        media.map(async (item) => ({
          ...item,
          source: await getAssetPortableSource(item.source),
        })),
      );
      await session.send({
        message: text,
        model,
        executionMode: mode,
        media: portableMedia,
      });
      setMedia([]);
    } catch (cause) {
      setError(String(cause));
      setMessage(text);
    }
  };
  return (
    <section
      className={`flex h-full min-h-0 flex-col ${compact ? "bg-surface-dark" : "mx-auto max-w-4xl"}`}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-dark px-4">
        <Sparkles className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-text-dark">
          {t(`rework.agent.${scope}`)}
        </h2>
        <select
          aria-label={t("rework.history")}
          value={state.sessionId ?? ""}
          onChange={(event) => {
            try {
              session.loadSession(event.target.value);
              setError("");
            } catch (cause) {
              setError(String(cause));
            }
          }}
          className="h-8 max-w-40 rounded-lg border border-border-dark bg-bg-dark px-2 text-[11px] text-text-muted"
        >
          <option value="">{t("rework.history")}</option>
          {session.listSessions().map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={running || !!state.approvals.length}
          title={t("rework.conversation")}
          aria-label={t("rework.conversation")}
          onClick={() => {
            session.newSession();
            setError("");
          }}
          className="rounded-lg p-2 text-text-muted hover:bg-bg-dark disabled:opacity-40"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      </header>
      <div
        ref={scroll}
        className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
      >
        {!state.messages.length && (
          <div className="flex h-full min-h-32 flex-col items-center justify-center text-center">
            <Sparkles className="mb-4 h-7 w-7 text-accent/70" />
            <p className="max-w-md text-sm leading-7 text-text-muted">
              {t("rework.agent.empty")}
            </p>
          </div>
        )}
        <div className="space-y-5">
          {state.messages.map((item, index) => (
            <div
              key={`${item.createdAt}-${index}`}
              className={
                item.role === "user"
                  ? "ml-6 rounded-xl border border-border-dark bg-surface-dark/60 p-4"
                  : "py-2"
              }
            >
              <p className="whitespace-pre-wrap break-words text-sm leading-7 text-text-dark">
                {item.text}
              </p>
            </div>
          ))}
          {state.liveText && (
            <p className="whitespace-pre-wrap text-sm leading-7 text-text-dark">
              {state.liveText}
            </p>
          )}
          {running && (
            <div
              role="status"
              className="flex items-center gap-2 py-3 text-xs text-text-muted"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("common.loading")}
            </div>
          )}
        </div>
        {!!state.toolEvents.length && (
          <details className="mt-4 rounded-lg border border-border-dark p-3">
            <summary className="cursor-pointer text-[11px] text-text-muted">
              Tools · {state.toolEvents.length}
            </summary>
            <div className="mt-2 space-y-2">
              {state.toolEvents.map((event, index) => (
                <div
                  key={event.callId ?? index}
                  className="flex items-center gap-2 text-[11px] text-text-muted"
                >
                  {event.status === "succeeded" ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  )}
                  <span>{event.toolName}</span>
                  <span className="ml-auto">{event.status}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {state.approvals.map((approval) => (
          <div
            key={approval.id}
            className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
          >
            <p className="text-sm font-medium text-text-dark">
              {t(`rework.agent.actions.${approval.toolName}`, { defaultValue: approval.summary })}
            </p>
            {approval.impact.summary !== approval.summary && (
              <p className="mt-2 text-xs leading-6 text-text-muted">{approval.impact.summary}</p>
            )}
            <details className="mt-2 text-[11px] text-text-muted">
              <summary className="cursor-pointer">
                {t("rework.channels.review")}
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(approval.arguments, null, 2)}
              </pre>
            </details>
            <div className="mt-3 flex justify-end gap-2">
              {[false, true].map((approve) => (
                <button
                  key={String(approve)}
                  type="button"
                  disabled={!model || running}
                  onClick={() => {
                    if (model)
                      void session
                        .resolveApproval({
                          approvalId: approval.id,
                          approve,
                          model,
                        })
                        .catch((cause: unknown) => setError(String(cause)));
                  }}
                  className={`h-9 rounded-lg px-3 text-xs ${approve ? "bg-accent text-white" : "border border-border-dark text-text-muted"}`}
                >
                  {t(approve ? "rework.agent.approve" : "rework.agent.deny")}
                </button>
              ))}
            </div>
          </div>
        ))}
        {(error || state.error) && (
          <p
            role="alert"
            className="mt-4 break-words rounded-lg border border-red-500/20 p-3 text-xs leading-6 text-red-400"
          >
            {error || state.error}
          </p>
        )}
      </div>
      <div className="shrink-0 p-4">
        <div className="rounded-2xl border border-border-dark bg-surface-dark p-3">
          {!!media.length && (
            <div className="mb-2 flex flex-wrap gap-2">
              {media.map((item) => (
                <button
                  key={item.assetId}
                  type="button"
                  onClick={() =>
                    setMedia(
                      media.filter(
                        (candidate) => candidate.assetId !== item.assetId,
                      ),
                    )
                  }
                  className="flex items-center gap-2 rounded-lg bg-bg-dark px-2 py-1 text-[11px] text-text-muted"
                >
                  {item.title}
                  <X className="h-3 w-3" />
                </button>
              ))}
            </div>
          )}
          <textarea
            aria-label={t("rework.agent.placeholder")}
            placeholder={t("rework.agent.placeholder")}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send();
              }
            }}
            className="block min-h-20 w-full resize-y bg-transparent text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="file"
              hidden
              accept="image/*"
              ref={upload}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  const source = await new Promise<string>(
                    (resolve, reject) => {
                      const reader = new FileReader();
                      reader.onload = () => resolve(String(reader.result));
                      reader.onerror = () => reject(reader.error);
                      reader.readAsDataURL(file);
                    },
                  );
                  const asset = await saveAsset({
                    kind: "image",
                    source,
                    name: file.name,
                    origin: "uploaded",
                    metadata: { mime: file.type },
                  });
                  setMedia((current) => [
                    ...current,
                    {
                      assetId: asset.id,
                      title: asset.name,
                      origin: "upload",
                      source: asset.source,
                      mimeType: file.type,
                    },
                  ]);
                } catch (cause) {
                  setError(String(cause));
                }
              }}
            />
            <button
              type="button"
              disabled={model && !model.supportsMultimodal}
              title={t("rework.upload")}
              aria-label={t("rework.upload")}
              onClick={() => upload.current?.click()}
              className="rounded-lg p-2 text-text-muted disabled:opacity-30"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <select
              aria-label={t("rework.model")}
              value={model?.id ?? ""}
              onChange={(event) => setModelId(event.target.value)}
              className="h-9 min-w-0 max-w-48 rounded-lg border border-border-dark bg-bg-dark px-2 text-[11px] text-text-dark"
            >
              <option value="">{t("rework.model")}</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.modelLabel}
                </option>
              ))}
            </select>
            <select
              aria-label={t("rework.agent.manual")}
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "manual" | "auto")
              }
              className="h-9 max-w-36 rounded-lg border border-border-dark bg-bg-dark px-2 text-[11px] text-text-muted"
            >
              <option value="manual">{t("rework.agent.manual")}</option>
              <option value="auto">{t("rework.agent.auto")}</option>
            </select>
            <button
              type="button"
              disabled={!cancelable && (!model || !message.trim())}
              onClick={() => (cancelable ? session.stop() : void send())}
              title={t(cancelable ? "rework.agent.stop" : "rework.agent.send")}
              aria-label={t(
                cancelable ? "rework.agent.stop" : "rework.agent.send",
              )}
              className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:bg-text-dark/10 disabled:text-text-muted"
            >
              {cancelable ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
          {!model && onSettings && (
            <button
              type="button"
              onClick={onSettings}
              className="mt-3 text-xs text-accent"
            >
              {t("rework.noModels")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
