import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Bot,
  ClipboardPaste,
  Copy,
  FlaskConical,
  FileUp,
  LayoutTemplate,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { unzipSync } from "fflate";
import { builtInPresets } from "@/features/channels/presets";
import {
  useChannelStore,
  channelProviderId,
  type ChannelRecord,
  getChannelCredential,
} from "@/features/channels/store/channelStore";
import {
  createChannel,
  updateChannel,
  deleteChannel,
  parseProfileImport,
  testChannelModels,
} from "@/features/channels/application/channelService";
import {
  describeChannelMigrationIssues,
  type ChannelMigrationIssueDescription,
} from "@/features/channels/application/channelMigrationIssues";
import {
  generateChannelProfile,
  getChannelSchemaPrompt,
  type ConfigurationAssistantInput,
} from "@/features/channels/application/configurationAssistant";
import type {
  ChannelProfileV2,
  ModelSpec,
} from "@/features/channels/domain/profile";
import { useChatModelCatalog } from "@/features/canvas/application/chatModelCatalog";
import {
  UiBadge,
  UiButton,
  UiConfirm,
  UiField,
  UiSelect,
  UiTextArea,
} from "@/components/ui";
import { ChannelTemplateBrowser } from "./ChannelTemplateBrowser";
import type { ChannelCapability } from "@/features/channels/application/channelCapabilities";
import { useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import { requestStudioPageNavigation } from "@/features/studio/studioNavigation";
import { ChannelMarketplace } from "./ChannelMarketplace";
import {
  recordChannelTest,
  clearChannelTest,
  useChannelUiStore,
  consumeChannelFocus,
} from "@/features/channels/application/channelUiStore";
import { ChannelProfileForm } from "./ChannelProfileForm";
import { ChannelRequestPreview } from "./ChannelRequestPreview";

// Reference selection, job monitoring and media players are only needed after explicitly opening a paid test.
const ChannelSmokeDialog = lazy(() =>
  import("./ChannelSmokeDialog").then((module) => ({
    default: module.ChannelSmokeDialog,
  })),
);

type Method = "template" | "assistant" | "paste";
/** pick: choose how to connect · input: method-specific source · review: form + live request preview. */
type Stage = "catalog" | "pick" | "input" | "review";

const METHODS: { id: Method; icon: typeof Bot }[] = [
  { id: "template", icon: LayoutTemplate },
  { id: "assistant", icon: WandSparkles },
  { id: "paste", icon: ClipboardPaste },
];

export function ChannelSettingsPage({ onClose }: { onClose?(): void } = {}) {
  const { t } = useTranslation();
  const channels = useChannelStore((state) => state.channels);
  const models = useChatModelCatalog();
  const [draft, setDraft] = useState<ChannelProfileV2>(() => ({
    ...structuredClone(builtInPresets[0]),
    id: crypto.randomUUID(),
  }));
  const [focusedModel, setFocusedModel] = useState<string | undefined>();
  const focusChannel = useChannelUiStore((state) => state.focusChannelId);
  const [pendingUse, setPendingUse] = useState<{
    channel: ChannelRecord;
    model: ModelSpec;
    kind: Exclude<ChannelCapability, "model">;
  } | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const discoveryRequest = useRef(0);
  const [discovering, setDiscovering] = useState(false);
  const savingRef = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [method, setMethod] = useState<Method>("template");
  const [stage, setStage] = useState<Stage>("catalog");
  const [origin, setOrigin] = useState<Method | null>(null);
  const [source, setSource] = useState("");
  const [docs, setDocs] = useState("");
  const [assistantModel, setAssistantModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [analysisRequest, setAnalysisRequest] =
    useState<ConfigurationAssistantInput | null>(null);
  const analyzingRef = useRef(false);
  const editorScope = useRef(0);
  const invalidateEditor = () => {
    editorScope.current++;
    discoveryRequest.current++;
    setDiscovering(false);
  };
  const backToCatalog = () => {
    invalidateEditor();
    setStage("catalog");
  };
  const docInput = useRef<HTMLInputElement>(null);
  const [smoke, setSmoke] = useState<{
    profile: ChannelProfileV2;
    credential: string;
  } | null>(null);
  const feedback = <Feedback error={error} notice={notice} />;
  const usableModel = models.find((model) => model.usable)?.id ?? "";
  const editingRecord = editing
    ? channels.find((record) => record.profile.id === editing)
    : undefined;
  const discoveryIdentity = JSON.stringify([stage, draft, key]);
  const currentDiscoveryIdentity = useRef(discoveryIdentity);
  currentDiscoveryIdentity.current = discoveryIdentity;
  useEffect(() => {
    discoveryRequest.current++;
    setDiscovering(false);
    setDiscoveredModels([]);
  }, [discoveryIdentity]);
  useEffect(
    () => () => {
      discoveryRequest.current++;
    },
    [],
  );

  const openRecord = (record: ChannelRecord, modelId?: string) => {
    invalidateEditor();
    setDraft(structuredClone(record.profile));
    setEditing(record.profile.id);
    setKey(getChannelCredential(record.profile.id));
    setFocusedModel(modelId);
    setDiscoveredModels([]);
    setOrigin(null);
    setError("");
    setNotice("");
    setStage("review");
  };
  useEffect(() => {
    if (!focusChannel) return;
    const record = channels.find((entry) => entry.profile.id === focusChannel);
    if (record) {
      openRecord(record);
      consumeChannelFocus();
    }
  }, [focusChannel, channels]);
  const useModel = (
    channel: ChannelRecord,
    model: ModelSpec,
    kind: Exclude<ChannelCapability, "model">,
  ) => {
    const mode = model.modes?.find((entry) =>
      kind === "chat"
        ? entry.operation === "chat"
        : entry.operation.startsWith(`${kind}.`),
    );
    useWorkbenchStore
      .getState()
      .setDraft({
        kind,
        model: `custom:${channelProviderId(channel.profile.id, kind)}:${model.id}`,
        prompt: "",
        references: [],
        referenceSlots: undefined,
        channelModeId: kind === 'image' && model.modes?.every(entry => entry.operation.startsWith('image.')) ? undefined : mode?.id,
        config: {},
      });
    setPendingUse(null);
    requestStudioPageNavigation("workbench");
    onClose?.();
  };
  const resetMessages = () => {
    setError("");
    setNotice("");
  };
  const choose = (profile: ChannelProfileV2, from: Method, credential = "") => {
    invalidateEditor();
    setDraft({ ...structuredClone(profile), id: crypto.randomUUID() });
    setEditing(null);
    setKey(credential);
    setOrigin(from);
    setFocusedModel(undefined);
    setDiscoveredModels([]);
    resetMessages();
    setStage("review");
  };
  const startNew = () => {
    invalidateEditor();
    setEditing(null);
    setOrigin(null);
    resetMessages();
    setFocusedModel(undefined);
    setDiscoveredModels([]);
    setStage("pick");
  };
  const pickMethod = (next: Method) => {
    invalidateEditor();
    setMethod(next);
    resetMessages();
    setStage("input");
  };
  const save = async () => {
    if (savingRef.current || analyzingRef.current) return;
    savingRef.current = true;
    const identity = discoveryIdentity;
    const scope = editorScope.current;
    resetMessages();
    setBusy(true);
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
      // The field shows the stored vault token unchanged, a new value, or "" after an explicit delete.
      if (editing) await updateChannel(editing, parsed.profile, key);
      else {
        await createChannel(parsed.profile, key);
        if (editorScope.current === scope) setEditing(parsed.profile.id);
      }
      clearChannelTest(parsed.profile.id);
      if (currentDiscoveryIdentity.current === identity) {
        setKey(getChannelCredential(parsed.profile.id));
        setNotice(t("rework.channels.saved"));
      }
    } catch (cause) {
      if (editorScope.current === scope)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setBusy(false);
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
    choose(result.profile, "paste");
  };
  const analyze = async (input: ConfigurationAssistantInput) => {
    if (analyzingRef.current || savingRef.current) return;
    analyzingRef.current = true;
    const scope = editorScope.current;
    setAnalysisRequest(null);
    setBusy(true);
    resetMessages();
    try {
      const result = await generateChannelProfile(input);
      if (editorScope.current !== scope) return;
      if (!result.ok)
        throw new Error(
          result.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("\n"),
        );
      choose(result.profile, "assistant");
    } catch (cause) {
      if (editorScope.current === scope) setError(String(cause));
    } finally {
      analyzingRef.current = false;
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
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(getChannelSchemaPrompt());
      setNotice(t("rework.channels.copied"));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const testModels = () => {
    const requestId = ++discoveryRequest.current;
    const identity = discoveryIdentity;
    const active = () =>
      discoveryRequest.current === requestId &&
      currentDiscoveryIdentity.current === identity;
    setDiscovering(true);
    resetMessages();
    void testChannelModels(draft, key)
      .then((result) => {
        if (!active()) return;
        if (!result.ok) throw new Error(result.error.message);
        if (
          JSON.stringify(
            useChannelStore
              .getState()
              .channels.find((entry) => entry.profile.id === draft.id)?.profile,
          ) === JSON.stringify(draft)
        )
          recordChannelTest(draft.id, {
            result: "passed",
            method: "models",
            modelCount: result.models.length,
          });
        setDiscoveredModels(result.models);
        setNotice(
          t("rework.channels.testSuccess", { count: result.models.length }),
        );
      })
      .catch((cause: unknown) => {
        if (!active()) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (
          JSON.stringify(
            useChannelStore
              .getState()
              .channels.find((entry) => entry.profile.id === draft.id)?.profile,
          ) === JSON.stringify(draft)
        )
          recordChannelTest(draft.id, { result: "failed", method: "models" });
        setError(message);
      })
      .finally(() => {
        if (active()) setDiscovering(false);
      });
  };

  const stepIndex = stage === "pick" ? 0 : stage === "input" ? 1 : 2;

  return (
    <section className="space-y-7 pr-1">
      {stage === "catalog" ? (
        <ChannelMarketplace
          channels={channels}
          onAdd={startNew}
          onEdit={openRecord}
          onDelete={setDeleting}
          onTry={(channel, model) =>
            setSmoke({
              profile: {
                ...structuredClone(channel.profile),
                models: [structuredClone(model)],
              },
              credential: getChannelCredential(channel.profile.id),
            })
          }
          onUse={(channel, model, kind) => {
            const existing = useWorkbenchStore.getState().draft;
            if (
              existing.prompt.trim() ||
              existing.references?.length ||
              Object.values(existing.referenceSlots ?? {}).some(
                (sources) => sources.length,
              )
            )
              setPendingUse({ channel, model, kind });
            else useModel(channel, model, kind);
          }}
        />
      ) : (
        <>
          <header className="flex items-start justify-between gap-3">
            <div>
              <BackLink onClick={backToCatalog}>
                {t("ui.channels.market.back")}
              </BackLink>
              <h2 className="mt-3 text-xl font-semibold">
                {editingRecord?.profile.name ?? t("ui.channels.market.add")}
              </h2>
              <p className="mt-2 text-sm text-text-muted">
                {t("ui.channels.market.setupHint")}
              </p>
            </div>
          </header>
          <div className="rounded-[var(--r-xl)] border border-[var(--line)] bg-[var(--field-bg)] p-5">
            {!editing && (
              <ol
                className="mb-5 flex flex-wrap items-center gap-2 text-xs"
                aria-label={t("rework.channels.steps")}
              >
                {(["stepMethod", "stepSource", "stepReview"] as const).map(
                  (step, index) => (
                    <li key={step} className="flex items-center gap-2">
                      {index > 0 && (
                        <span
                          className="h-px w-6 bg-[var(--line-strong)]"
                          aria-hidden
                        />
                      )}
                      <span
                        aria-current={index === stepIndex ? "step" : undefined}
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors ${index < stepIndex ? "bg-accent/20 text-accent" : index === stepIndex ? "bg-accent text-white" : "bg-[var(--press)] text-text-subtle"}`}
                      >
                        {index + 1}
                      </span>
                      <span
                        className={
                          index === stepIndex
                            ? "font-medium text-text-dark"
                            : "text-text-subtle"
                        }
                      >
                        {t(`rework.channels.${step}`)}
                      </span>
                    </li>
                  ),
                )}
              </ol>
            )}

            {stage === "pick" && (
              <div className="grid gap-3 md:grid-cols-3">
                {METHODS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => pickMethod(item.id)}
                    className="group flex flex-col items-start gap-3 rounded-[var(--r-lg)] border border-[var(--line)] bg-surface p-4 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-[var(--shadow-pop)] active:translate-y-0"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-accent/12 text-accent">
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-text-dark">
                        {t(`rework.channels.method.${item.id}.title`)}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-text-muted">
                        {t(`rework.channels.method.${item.id}.body`)}
                      </span>
                    </span>
                    <span className="mt-auto text-[11.5px] text-text-subtle">
                      {t(`rework.channels.method.${item.id}.when`)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {stage === "input" && (
              <div className="space-y-4">
                <BackLink onClick={() => setStage("pick")}>
                  {t(`rework.channels.method.${method}.title`)}
                </BackLink>
                {method === "template" && (
                  <ChannelTemplateBrowser
                    onChoose={(profile, credential) => choose(profile, "template", credential)}
                  />
                )}
                {method === "assistant" && (
                  <div className="space-y-4">
                    <UiField
                      label={t("rework.channels.assistantModel")}
                      hint={
                        !usableModel
                          ? t("rework.channels.assistantNeedsModel")
                          : undefined
                      }
                    >
                      <UiSelect
                        aria-label={t("rework.channels.assistantModel")}
                        value={assistantModel || usableModel}
                        onChange={(event) =>
                          setAssistantModel(event.target.value)
                        }
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
                      </UiSelect>
                    </UiField>
                    <UiField
                      label={t("rework.channels.documentation")}
                      trailing={
                        <>
                          <UiButton
                            variant="ghost"
                            size="sm"
                            icon={<FileUp />}
                            className="ml-auto"
                            onClick={() => docInput.current?.click()}
                          >
                            {t("rework.channels.uploadDoc")}
                          </UiButton>
                          <input
                            ref={docInput}
                            type="file"
                            hidden
                            accept=".txt,.md,.json,.html,.docx"
                            aria-label={t("rework.channels.documentation")}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void uploadDoc(file);
                              event.target.value = "";
                            }}
                          />
                        </>
                      }
                    >
                      <UiTextArea
                        value={docs}
                        onChange={(event) => setDocs(event.target.value)}
                        placeholder={t("rework.channels.documentationHint")}
                        className="min-h-40"
                      />
                    </UiField>
                    <UiButton
                      variant="primary"
                      icon={<WandSparkles />}
                      loading={busy}
                      disabled={
                        busy ||
                        !docs.trim() ||
                        !models.some(
                          (model) =>
                            model.id === (assistantModel || usableModel) &&
                            model.usable,
                        )
                      }
                      onClick={() =>
                        setAnalysisRequest({
                          modelId: assistantModel || usableModel,
                          ...(/^https?:\/\/\S+$/.test(docs.trim())
                            ? { docsUrl: docs.trim() }
                            : { docsText: docs }),
                        })
                      }
                    >
                      {t(
                        busy
                          ? "rework.channels.analyzing"
                          : "rework.channels.analyze",
                      )}
                    </UiButton>
                  </div>
                )}
                {method === "paste" && (
                  <ol className="space-y-4">
                    <PasteStep
                      index={1}
                      title={t("rework.channels.pasteStep1")}
                    >
                      <UiButton
                        icon={<Copy />}
                        onClick={() => void copyPrompt()}
                      >
                        {t("rework.channels.copyPrompt")}
                      </UiButton>
                    </PasteStep>
                    <PasteStep
                      index={2}
                      title={t("rework.channels.pasteStep2")}
                    />
                    <PasteStep
                      index={3}
                      title={t("rework.channels.pasteStep3")}
                    >
                      <UiTextArea
                        aria-label={t("rework.channels.paste")}
                        value={source}
                        onChange={(event) => setSource(event.target.value)}
                        placeholder={'{ "name": … }'}
                        className="min-h-48 font-mono text-xs"
                      />
                      <UiButton
                        variant="primary"
                        className="mt-3"
                        disabled={!source.trim()}
                        onClick={importSource}
                      >
                        {t("rework.channels.import")}
                      </UiButton>
                    </PasteStep>
                  </ol>
                )}
              </div>
            )}

            {stage === "review" && (
              <div className="space-y-4">
                {!editing && (
                  <BackLink onClick={() => setStage("input")}>
                    {t("rework.channels.backToSource")}
                  </BackLink>
                )}
                {origin && origin !== "template" && !editing && (
                  <p className="rounded-[var(--r-md)] border border-accent/25 bg-accent/8 px-3 py-2 text-xs leading-5 text-text-dark">
                    {t("rework.channels.reviewGenerated")}
                  </p>
                )}
                {editingRecord && editingRecord.migrationIssues.length > 0 && (
                  <MigrationDetails
                    issues={describeChannelMigrationIssues(editingRecord)}
                  />
                )}
                <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <ChannelProfileForm
                    key={draft.id}
                    focusedModelId={focusedModel}
                    discoveredModels={discoveredModels}
                    draft={draft}
                    onChange={setDraft}
                    credential={key}
                    onCredential={setKey}
                    busy={busy || discovering}
                    onSave={() => void save()}
                    onError={setError}
                    onTest={testModels}
                    feedback={feedback}
                  />
                  <ChannelRequestPreview profile={draft} />
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
                  <UiButton
                    icon={<FlaskConical />}
                    disabled={busy}
                    onClick={() =>
                      setSmoke({
                        profile: structuredClone(draft),
                        credential: key,
                      })
                    }
                  >
                    {t("rework.channels.smoke.title")}
                  </UiButton>
                  <p className="text-xs text-text-muted">
                    {t("rework.channels.smoke.entryHint")}
                  </p>
                </div>
              </div>
            )}

            {stage !== "review" && (error || notice) ? (
              <div className="mt-4">{feedback}</div>
            ) : null}
          </div>
        </>
      )}
      <UiConfirm
        isOpen={Boolean(pendingUse)}
        title={t("ui.channels.market.replaceDraft")}
        description={t("ui.channels.market.replaceDraftHint")}
        confirmLabel={t("common.confirm")}
        onClose={() => setPendingUse(null)}
        onConfirm={() => {
          if (pendingUse)
            useModel(pendingUse.channel, pendingUse.model, pendingUse.kind);
        }}
      />
      <UiConfirm
        isOpen={analysisRequest !== null}
        title={t("rework.channels.analysisApprovalTitle")}
        description={t("rework.channels.analysisApprovalBody", {
          model:
            models.find((model) => model.id === analysisRequest?.modelId)
              ?.modelLabel ??
            analysisRequest?.modelId ??
            "",
          source:
            analysisRequest?.docsUrl ??
            t("rework.channels.documentCharacters", {
              count: analysisRequest?.docsText?.length ?? 0,
            }),
        })}
        tone="primary"
        confirmLabel={t("rework.channels.analysisApprove")}
        onClose={() => setAnalysisRequest(null)}
        onConfirm={() => {
          if (analysisRequest) void analyze(analysisRequest);
        }}
      />
      <UiConfirm
        isOpen={!!deleting}
        title={t("rework.delete")}
        description={t("rework.channels.deleteConfirm")}
        confirmLabel={t("rework.delete")}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          deleteChannel(deleting);
          if (editing === deleting) setStage("catalog");
          clearChannelTest(deleting);
          setDeleting(null);
        }}
      />
      {smoke && (
        <Suspense
          fallback={
            <p role="status" className="text-xs text-text-muted">
              {t("common.loading")}
            </p>
          }
        >
          <ChannelSmokeDialog
            profile={smoke.profile}
            credential={smoke.credential}
            onClose={() => setSmoke(null)}
          />
        </Suspense>
      )}
    </section>
  );
}

const MIGRATION_KIND_LABEL: Record<
  ChannelMigrationIssueDescription["kind"],
  string
> = {
  dropped: "rework.channels.migrationDropped",
  converted: "rework.channels.migrationConverted",
  unsupported: "rework.channels.migrationUnsupported",
};

/** What the legacy-config migration dropped, converted or could not reproduce; never shows legacy values. */
function MigrationDetails({
  issues,
}: {
  issues: ChannelMigrationIssueDescription[];
}) {
  const { t } = useTranslation();
  return (
    <details className="rounded-[var(--r-md)] border border-warning/30 bg-warning/8 px-3 py-2 text-xs leading-5 text-text-dark">
      <summary className="cursor-pointer select-none font-medium">
        {t("rework.channels.migrationDetailsTitle")} ·{" "}
        {t("rework.channels.migrationNotes", { count: issues.length })}
      </summary>
      <table className="mt-2 w-full table-fixed border-collapse">
        <thead className="text-left text-text-muted">
          <tr>
            <th className="w-[34%] py-1 pr-2 font-normal">
              {t("rework.channels.migrationPath")}
            </th>
            <th className="w-[22%] py-1 pr-2 font-normal" />
            <th className="py-1 font-normal" />
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr
              key={`${issue.path}:${index}`}
              className="border-t border-[var(--line)] align-top"
            >
              <td className="break-all py-1.5 pr-2 font-mono text-[11px]">
                {issue.path}
              </td>
              <td className="py-1.5 pr-2">
                <UiBadge
                  tone={issue.kind === "converted" ? "neutral" : "warning"}
                >
                  {t(MIGRATION_KIND_LABEL[issue.kind])}
                </UiBadge>
              </td>
              <td className="break-words py-1.5 text-text-muted">
                {issue.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (error) {
    return (
      <pre
        role="alert"
        className="whitespace-pre-wrap break-words rounded-[var(--r-md)] border border-danger/25 bg-danger/8 p-3 text-xs leading-6 text-danger"
      >
        {error}
      </pre>
    );
  }
  if (!notice) return null;
  return (
    <p
      role="status"
      className="rounded-[var(--r-md)] border border-success/25 bg-success/8 p-3 text-xs leading-6 text-success"
    >
      {notice}
    </p>
  );
}

function BackLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] py-1 pr-2 text-[13px] font-medium text-text-dark hover:text-accent"
    >
      <ArrowLeft className="h-4 w-4" />
      {children}
    </button>
  );
}

function PasteStep({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--press)] text-[11px] font-semibold text-text-muted">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-6 text-text-dark">{title}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}
