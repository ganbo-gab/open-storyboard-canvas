import { useState } from "react";
import {
  Copy,
  FileText,
  Loader2,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { unzipSync } from "fflate";
import { builtInPresets } from "@/features/channels/presets";
import {
  useChannelStore,
  credentialConfigured,
} from "@/features/channels/store/channelStore";
import {
  createChannel,
  updateChannel,
  deleteChannel,
  parseProfileImport,
  testChannelModels,
} from "@/features/channels/application/channelService";
import {
  generateChannelProfile,
  getChannelSchemaPrompt,
} from "@/features/channels/application/configurationAssistant";
import type { ChannelProfileV2 } from "@/features/channels/domain/profile";
import { useChatModelCatalog } from "@/features/canvas/application/chatModelCatalog";
import { UiButton, UiTextArea } from "@/components/ui";
import { ChannelProfileForm } from "./ChannelProfileForm";
import { ChannelRequestPreview } from "./ChannelRequestPreview";

type Method = "template" | "assistant" | "paste";
export function ChannelSettingsPage() {
  const { t } = useTranslation();
  const channels = useChannelStore((state) => state.channels);
  const models = useChatModelCatalog();
  const [draft, setDraft] = useState<ChannelProfileV2>(() => ({
    ...structuredClone(builtInPresets[0]),
    id: crypto.randomUUID(),
  }));
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [method, setMethod] = useState<Method>("template");
  const [source, setSource] = useState("");
  const [docs, setDocs] = useState("");
  const [assistantModel, setAssistantModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const choose = (profile: ChannelProfileV2) => {
    setDraft({ ...structuredClone(profile), id: crypto.randomUUID() });
    setEditing(null);
    setKey("");
    setError("");
    setNotice("");
  };
  const save = () => {
    setError("");
    setNotice("");
    try {
      const parsed = parseProfileImport(JSON.stringify(draft));
      if (!parsed.ok)
        throw new Error(
          parsed.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("\n"),
        );
      if (!draft.models.length)
        throw new Error(t("rework.channels.missingModel"));
      if (editing) updateChannel(editing, parsed.profile, key || undefined);
      else {
        createChannel(parsed.profile, key);
        setEditing(parsed.profile.id);
      }
      setNotice(t("rework.channels.saved"));
      setKey("");
    } catch (cause) {
      setError(String(cause));
    }
  };
  const importSource = () => {
    const result = parseProfileImport(source);
    if (!result.ok) {
      setError(
        result.errors.map((item) => `${item.path}: ${item.message}`).join("\n"),
      );
      return;
    }
    choose(result.profile);
    setMethod("template");
  };
  const analyze = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await generateChannelProfile({
        modelId:
          assistantModel || models.find((model) => model.usable)?.id || "",
        ...(/^https?:\/\/\S+$/.test(docs.trim())
          ? { docsUrl: docs.trim() }
          : { docsText: docs }),
      });
      if (!result.ok)
        throw new Error(
          result.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("\n"),
        );
      choose(result.profile);
      setMethod("template");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const uploadDoc = async (file: File) => {
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Document exceeds 8MB");
      if (file.name.toLowerCase().endsWith(".docx")) {
        const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
        if (!files["word/document.xml"]) throw new Error("Invalid DOCX");
        const xml = new DOMParser().parseFromString(
          new TextDecoder().decode(files["word/document.xml"]),
          "application/xml",
        );
        setDocs(
          Array.from(xml.getElementsByTagName("w:p"))
            .map((paragraph) => paragraph.textContent)
            .join("\n"),
        );
      } else setDocs(await file.text());
    } catch (cause) {
      setError(String(cause));
    }
  };
  return (
    <section className="space-y-6 pr-1">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-text-dark">
          {t("rework.channels.title")}
        </h2>
        <p className="mt-2 max-w-2xl text-xs leading-6 text-text-muted">
          {t("rework.channels.hint")}
        </p>
      </header>
      {!!channels.length && (
        <div className="grid gap-2 sm:grid-cols-2">
          {channels.map((record) => (
            <div
              key={`${record.origin}-${record.profile.id}`}
              className={`flex min-w-0 items-center gap-3 rounded-xl border p-3 ${editing === record.profile.id ? "border-accent/50 bg-accent/5" : "border-border-dark bg-surface-dark/50"}`}
            >
              <button
                type="button"
                onClick={() => {
                  setDraft(structuredClone(record.profile));
                  setEditing(record.profile.id);
                  setKey("");
                  setNotice("");
                  setError("");
                  setSource(JSON.stringify(record.profile, null, 2));
                }}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-xs font-medium text-text-dark">
                  {record.profile.name}
                </div>
                <div className="mt-1 truncate text-[11px] text-text-muted">
                  {record.profile.baseUrl}
                </div>
                <div className="mt-1 text-[10px] text-text-muted">
                  {credentialConfigured(record.profile.id)
                    ? t("rework.configured")
                    : t("rework.notConfigured")}
                  {record.migrationIssues.length
                    ? ` · ${record.migrationIssues.length} migration notes`
                    : ""}
                </div>
              </button>
              <button
                type="button"
                aria-label={t("rework.delete")}
                onClick={() => {
                  if (window.confirm(t("rework.channels.deleteConfirm"))) {
                    deleteChannel(record.profile.id);
                    if (editing === record.profile.id)
                      choose(builtInPresets[0]);
                  }
                }}
                className="rounded-lg p-2 text-text-muted hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-b border-border-dark pb-4">
        {(["template", "assistant", "paste"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setMethod(item)}
            className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs ${method === item ? "border-accent/40 bg-accent/8 text-accent" : "border-border-dark text-text-muted hover:bg-surface-dark"}`}
          >
            {item === "assistant" ? (
              <WandSparkles className="h-3.5 w-3.5" />
            ) : item === "paste" ? (
              <FileText className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t(
              `rework.channels.${item === "template" ? "templates" : item === "assistant" ? "assistant" : "paste"}`,
            )}
          </button>
        ))}
      </div>
      {method === "assistant" && (
        <div className="space-y-3 rounded-xl border border-border-dark p-4">
          <label className="block text-xs text-text-muted">
            {t("rework.channels.assistantModel")}
            <select
              value={
                assistantModel || models.find((model) => model.usable)?.id || ""
              }
              onChange={(event) => setAssistantModel(event.target.value)}
              className="mt-2 h-10 w-full rounded-lg border border-border-dark bg-bg-dark px-3 text-xs text-text-dark"
            >
              <option value="">{t("rework.model")}</option>
              {models.map((model) => (
                <option
                  key={model.id}
                  value={model.id}
                  disabled={!model.usable}
                >
                  {model.providerLabel} · {model.modelLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-text-muted">
            {t("rework.channels.documentation")}
            <UiTextArea
              value={docs}
              onChange={(event) => setDocs(event.target.value)}
              className="mt-2 min-h-40"
            />
          </label>
          <input
            type="file"
            accept=".txt,.md,.json,.html,.docx"
            aria-label={t("rework.channels.documentation")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadDoc(file);
              event.target.value = "";
            }}
            className="block w-full text-xs text-text-muted"
          />
          <UiButton
            type="button"
            variant="primary"
            disabled={
              busy || !docs.trim() || !models.some((model) => model.usable)
            }
            onClick={() => void analyze()}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <WandSparkles className="mr-2 h-4 w-4" />
            )}
            {t(busy ? "rework.channels.analyzing" : "rework.channels.analyze")}
          </UiButton>
        </div>
      )}
      {method === "paste" && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(getChannelSchemaPrompt());
                setNotice(t("rework.channels.copied"));
              } catch (cause) {
                setError(String(cause));
              }
            }}
            className="flex h-9 items-center gap-2 rounded-lg border border-border-dark px-3 text-xs text-text-dark"
          >
            <Copy className="h-3.5 w-3.5" />
            {t("rework.channels.copyPrompt")}
          </button>
          <label className="block text-xs text-text-muted">
            {t("rework.channels.paste")}
            <UiTextArea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="mt-2 min-h-56 font-mono text-xs"
            />
          </label>
          <UiButton onClick={importSource}>
            {t("rework.channels.import")}
          </UiButton>
        </div>
      )}
      {method === "template" && (
        <>
          <div className="flex flex-wrap gap-2">
            {builtInPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => choose(preset)}
                className="rounded-lg border border-border-dark px-3 py-2 text-xs text-text-muted hover:border-accent/50 hover:text-text-dark"
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            <ChannelProfileForm
              draft={draft}
              onChange={setDraft}
              credential={key}
              onCredential={setKey}
              editing={!!editing}
              busy={busy}
              onSave={save}
              onError={setError}
              onTest={() => {
                setBusy(true);
                setError("");
                void testChannelModels(draft, key || undefined)
                  .then((result) => {
                    if (!result.ok) throw new Error(result.error.message);
                    setNotice(
                      t("rework.channels.testSuccess", {
                        count: result.models.length,
                      }),
                    );
                  })
                  .catch((cause: unknown) => setError(String(cause)))
                  .finally(() => setBusy(false));
              }}
            />
            <ChannelRequestPreview profile={draft} />
          </div>
        </>
      )}
      {error && (
        <pre
          role="alert"
          className="whitespace-pre-wrap break-words rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs leading-6 text-red-400"
        >
          {error}
        </pre>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs leading-6 text-emerald-500"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
