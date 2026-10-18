import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Settings2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "../store/workbenchStore";
import { useCreationModels } from "./useCreationModels";
import { ModelChoice } from "./ModelChoice";
import type { WorkbenchKind, WorkbenchReference } from "../domain/types";
import { resolveNativeChannelModel } from "@/features/channels/application/channelService";
import { DeclaredParameters } from "./DeclaredParameters";
import { AssetMedia } from "@/features/assets/ui/AssetMedia";

type Props = { onSubmitted?: () => void; onSettings: () => void };
export function WorkbenchComposer({ onSubmitted, onSettings }: Props) {
  const { t } = useTranslation();
  const draft = useWorkbenchStore((state) => state.draft);
  const setDraft = useWorkbenchStore((state) => state.setDraft);
  const submit = useWorkbenchStore((state) => state.submit);
  const initialized = useWorkbenchStore((state) => state.initialized);
  const models = useCreationModels(draft.kind);
  const model = models.find((item) => item.id === draft.model);
  const native = resolveNativeChannelModel(draft.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!initialized) return;
    if (!models.some((item) => item.id === draft.model && item.usable)) {
      const first = models.find((item) => item.usable);
      if (draft.model !== (first?.id ?? ""))
        setDraft({ model: first?.id ?? "", config: {} });
    }
  }, [initialized, models, draft.model, setDraft]);
  useEffect(() => {
    if (editor.current) {
      editor.current.style.height = "0px";
      editor.current.style.height = `${Math.min(280, Math.max(92, editor.current.scrollHeight))}px`;
    }
  }, [draft.prompt]);
  const send = async () => {
    if (!initialized || busy || !draft.prompt.trim() || !model?.usable) return;
    setBusy(true);
    setError("");
    try {
      await submit({ ...draft });
      onSubmitted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const addFiles = async (files: FileList | File[]) => {
    setError("");
    try {
      const additions: WorkbenchReference[] = [];
      for (const file of Array.from(files)) {
        if (!/^(image|video|audio)\//.test(file.type))
          throw new Error(t("rework.references"));
        const source = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        additions.push({
          id: crypto.randomUUID(),
          kind: file.type.startsWith("image/")
            ? "image"
            : file.type.startsWith("video/")
              ? "video"
              : "audio",
          source,
          name: file.name,
        });
      }
      setDraft({
        references: [
          ...(useWorkbenchStore.getState().draft.references ?? []),
          ...additions,
        ],
      });
    } catch (cause) {
      setError(String(cause));
    }
  };
  return (
    <div
      className="studio-composer rounded-2xl border border-border-dark bg-surface-dark p-4 shadow-xl"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }
      }}
    >
      {!!draft.references?.length && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {draft.references.map((reference, index) => (
            <div
              key={reference.id}
              className="relative flex h-16 w-20 shrink-0 items-center justify-center rounded-lg border border-border-dark bg-bg-dark text-xs text-text-muted"
            >
              {reference.kind === "image" ? (
                <AssetMedia
                  source={reference.source}
                  kind="image"
                  alt={reference.name ?? ""}
                  className="h-full w-full rounded-lg object-cover"
                />
              ) : (
                <span>
                  {reference.kind} {index + 1}
                </span>
              )}
              <button
                type="button"
                aria-label={t("rework.removeReference")}
                onClick={() =>
                  setDraft({
                    references: draft.references?.filter(
                      (item) => item.id !== reference.id,
                    ),
                  })
                }
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-bg-dark text-text-dark"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={editor}
        aria-label={t("rework.prompt")}
        value={draft.prompt}
        onChange={(event) => setDraft({ prompt: event.target.value })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={t("rework.promptHint")}
        className="ui-scrollbar block w-full resize-none bg-transparent text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          title={t("rework.upload")}
          aria-label={t("rework.upload")}
          onClick={() => input.current?.click()}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark text-text-muted hover:bg-bg-dark"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <select
          aria-label={t("rework.mode")}
          value={draft.kind}
          onChange={(event) =>
            setDraft({
              kind: event.target.value as WorkbenchKind,
              model: "",
              config: {},
            })
          }
          className="h-9 rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
        >
          {(["image", "video", "audio", "chat"] as const).map((kind) => (
            <option key={kind} value={kind}>
              {t(`rework.${kind}`)}
            </option>
          ))}
        </select>
        <ModelChoice
          models={models}
          value={draft.model}
          onChange={(id) => setDraft({ model: id, config: {} })}
        />
        {!native && !!model?.ratios.length && (
          <select
            aria-label={t("rework.ratio")}
            value={draft.config?.aspectRatio ?? ""}
            onChange={(event) =>
              setDraft({
                config: {
                  ...draft.config,
                  aspectRatio: event.target.value || undefined,
                },
              })
            }
            className="h-9 max-w-28 rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
          >
            <option value="">{t("rework.ratio")}</option>
            {model.ratios.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        {!native && !!model?.resolutions.length && (
          <select
            aria-label={t("rework.resolution")}
            value={draft.config?.size ?? ""}
            onChange={(event) =>
              setDraft({
                config: {
                  ...draft.config,
                  size: event.target.value || undefined,
                },
              })
            }
            className="h-9 max-w-28 rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
          >
            <option value="">{t("rework.resolution")}</option>
            {model.resolutions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        {!native && !!model?.durations.length && (
          <select
            aria-label={t("rework.seconds")}
            value={draft.config?.seconds ?? ""}
            onChange={(event) =>
              setDraft({
                config: {
                  ...draft.config,
                  seconds: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                },
              })
            }
            className="h-9 rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
          >
            <option value="">{t("rework.seconds")}</option>
            {model.durations.map((value) => (
              <option key={value} value={value}>
                {value}s
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={busy || !draft.prompt.trim() || !model?.usable}
          onClick={() => void send()}
          title="⌘ / Ctrl + Enter"
          aria-label={t("rework.generate")}
          className="stage-send-icon ml-auto flex h-9 w-9 shrink-0 items-center justify-center"
        >
          <ArrowUp className={`h-5 w-5 ${busy ? "animate-pulse" : ""}`} />
        </button>
      </div>
      {native && (
        <DeclaredParameters
          params={native.model.params}
          values={draft.config?.extraParams ?? {}}
          onChange={(extraParams) =>
            setDraft({ config: { ...draft.config, extraParams } })
          }
        />
      )}
      {!models.some((item) => item.usable) && (
        <button
          type="button"
          onClick={onSettings}
          className="mt-3 flex items-center gap-2 text-xs text-accent"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t("rework.noModels")}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
