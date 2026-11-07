import { assignWorkbenchReferenceToSlot, withWorkbenchChannelDefaults } from '../application/nativeChannelInput';
import { resolveWorkbenchMode, usesAutomaticImageMode } from '../application/workbenchImageMode';
import { parameterSummary } from '@/features/channels/ui/parameterPresentation';
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, BookText, ChevronDown, Info, Layers, SlidersHorizontal, AudioLines, Film, FolderOpen, ImagePlus, Images, LayoutGrid, MessageSquareText, Music2, Settings2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "../store/workbenchStore";
import { PromptEditor } from '@/features/canvas/composer/PromptEditor';
import { useTextDraft } from '@/features/canvas/composer/usePromptDraft';
import type { ComposerReference } from '@/features/canvas/composer/useNodeReferences';
import { useMaterialLibraryStore } from '@/features/library/materials/materialStore';
import { applyMaterialToPrompt } from '@/features/library/materials/materials';
import { rebaseWorkbenchReferenceTokens, workbenchSlotReferences, WORKBENCH_REFERENCE_PREFIX } from '../application/referenceOrder';
import { useCreationModels } from "./useCreationModels";
import { ModelChoice } from "./ModelChoice";
import type { WorkbenchKind, WorkbenchReference } from "../domain/types";
import { isReferenceFile, readReferenceFile } from "../application/readReferenceFile";
import { describeReferenceLimits, getWorkbenchValidationContext, validateWorkbenchDraft } from "../application/workbenchValidation";
import { AssetPickerDialog, type AssetPickerSource } from "@/features/assets/ui/AssetPickerDialog";
import { validationIssueText, workbenchErrorText } from "./workbenchErrorText";
import { resolveNativeChannelModel } from "@/features/channels/application/channelService";
import { resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { listModelModes, resolveModelModeOrFirst } from "@/features/channels/application/modelModes";
import type { RefSlot } from "@/features/channels/domain/profile";
import { ChannelModeControls } from "@/features/channels/ui/ChannelModeControls";
import { ComposerParameterPanel } from './ComposerParameterPanel';
import { AssetMedia } from "@/features/assets/ui/AssetMedia";
import { MenuItem, MenuSeparator, MenuSurface, PopoverSurface, UiButton, anchorAbove, type MenuAnchor } from "@/components/ui";
import { UiSelect } from "@/components/ui/primitives";
import { listAssets } from "@/features/assets/application/assetCatalog";
import { hasStudioMediaDrag, readStudioMediaDrag, type StudioMediaDrag } from "@/features/studio/mediaDrag";

const REFERENCE_KINDS = ["image", "video", "audio"] as const;

const KINDS: { id: WorkbenchKind; icon: typeof Images }[] = [
  { id: "image", icon: Images },
  { id: "video", icon: Film },
  { id: "audio", icon: Music2 },
  { id: "chat", icon: MessageSquareText },
];
type Props = { onSubmitted?: () => void; onSettings: () => void; browsing?: boolean };
export function WorkbenchComposer({ onSubmitted, onSettings, browsing = false }: Props) {
  const { t, i18n } = useTranslation();
  const draft = useWorkbenchStore((state) => state.draft);
  const setDraft = useWorkbenchStore((state) => state.setDraft);
  const submit = useWorkbenchStore((state) => state.submit);
  const initialized = useWorkbenchStore((state) => state.initialized);
  const models = useCreationModels(draft.kind);
  const selectedModelId = resolveChannelCatalogModelId(draft.model);
  const model = models.find((item) => item.id === selectedModelId);
  const native = resolveNativeChannelModel(draft.model);
  // Explicit modes replace the generic reference strip with declared slots.
  const modes = native?.model.modes?.length ? listModelModes(native.model) : null;
  const canAutoImage = Boolean(draft.kind === 'image' && native?.model.modes?.length && native.model.modes.every(mode => mode.operation.startsWith('image.')));
  const autoImage = Boolean(native && usesAutomaticImageMode(draft, native.model));
  let activeMode = native ? resolveModelModeOrFirst(native.model, draft.channelModeId) : null;
  try { if (native) activeMode = resolveWorkbenchMode(draft, native.model); }
  catch {
    // Keep already assigned images visible while an overflow/ambiguous addition needs correction.
    activeMode = modes?.find(mode => mode.slots.some(slot => draft.referenceSlots?.[slot.key]?.length)) ?? activeMode;
  }
  const slotInput = useRef<HTMLInputElement>(null);
  const [pendingSlot, setPendingSlot] = useState<RefSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const conversationId = useWorkbenchStore((state) => state.selectedConversationId);
  const promptDraft = useTextDraft(conversationId ?? 'new', draft.prompt, (prompt) => setDraft({ prompt }));
  const materials = useMaterialLibraryStore((state) => state.entries);
  useEffect(() => { void useMaterialLibraryStore.getState().initialize(); }, []);
  const promptReferences = useMemo(() => modes && activeMode ? [...workbenchSlotReferences(activeMode.slots, draft.referenceSlots ?? {}), ...(draft.references ?? [])] : draft.references ?? [], [draft.references, draft.referenceSlots, modes, activeMode]);
  const references = useMemo<ComposerReference[]>(() => {
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    const prefixes = WORKBENCH_REFERENCE_PREFIX;
    return promptReferences.map((reference) => {
      const label = `${prefixes[reference.kind]}${++counts[reference.kind]}`;
      return { sourceNodeId: reference.id, kind: reference.kind, label, token: `@${label}`, title: reference.name ?? label, displayUrl: reference.kind === 'image' ? reference.source : null };
    });
  }, [promptReferences]);
  const [mentionRequest, setMentionRequest] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'type' | 'params' | 'mode' | 'info' | 'presets' | 'refs'; anchor: MenuAnchor } | null>(null);
  const [presetSearch, setPresetSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<number | null>(null);
  const [refMenu, setRefMenu] = useState<MenuAnchor | null>(null);
  const [picker, setPicker] = useState<AssetPickerSource | null>(null);
  // Same validator as submit; the channel store is read inside, `models` re-renders on catalogue changes.
  const validation = useMemo(() => validateWorkbenchDraft({ ...draft, prompt: promptDraft.value }, getWorkbenchValidationContext(draft)), [draft, promptDraft.value, models]);
  const limits = useMemo(() => describeReferenceLimits(draft), [draft, models]);
  // An empty prompt only disables send; every other issue is explained before submitting.
  const hints = validation.issues.filter((issue) => issue.code !== "prompt.required");
  const remaining = Object.fromEntries(REFERENCE_KINDS.flatMap((kind) => {
    const limit = limits[kind];
    return limit === undefined ? [] : [[kind, Math.max(0, limit - (draft.references ?? []).filter((reference) => reference.kind === kind).length)]];
  }));
  const limitParts = [
    limits.image !== undefined ? t("rework.refMenu.limitImage", { count: limits.image }) : "",
    limits.video !== undefined ? t("rework.refMenu.limitVideo", { count: limits.video }) : "",
    limits.audio !== undefined ? t("rework.refMenu.limitAudio", { count: limits.audio }) : "",
    limits.maxBytes !== undefined ? t("rework.refMenu.limitBytes", { size: `${Math.round(limits.maxBytes / 1024 / 1024)}MB` }) : "",
  ].filter(Boolean);
  useEffect(() => {
    if (!initialized) return;
    if (!draft.model) {
      const first = models.find((item) => item.usable);
      if (draft.model !== (first?.id ?? ""))
        setDraft({ model: first?.id ?? "", config: {} });
    }
  }, [initialized, models, draft.model, setDraft]);
  useEffect(() => {
    if (!initialized || !native?.model.modes?.length || !draft.references?.length) return;
    const normalized = withWorkbenchChannelDefaults({ ...draft, prompt: promptDraft.read() });
    if (normalized.references !== draft.references) {
      promptDraft.flush(normalized.prompt);
      setDraft({ references: normalized.references, referenceSlots: normalized.referenceSlots, prompt: normalized.prompt });
    }
  }, [initialized, native, draft, setDraft, promptDraft.read, promptDraft.flush]);
  useEffect(() => {
    if (!browsing) { setCollapsed(false); return; }
    if (!panel && !refMenu && !picker && !root.current?.contains(document.activeElement)) setCollapsed(true);
  }, [browsing, panel, refMenu, picker]);
  const togglePanel = (kind: NonNullable<typeof panel>['kind'], element: HTMLElement) => { setPanel((current) => current?.kind === kind ? null : { kind, anchor: anchorAbove(element) }); setPresetSearch(''); };
  const submitting = useRef(false);
  const send = async () => {
    promptDraft.flush();
    const currentDraft = useWorkbenchStore.getState().draft;
    if (!initialized || submitting.current || busy || !currentDraft.prompt.trim() || !model?.usable || validateWorkbenchDraft(currentDraft, getWorkbenchValidationContext(currentDraft)).blocking) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await submit({ ...currentDraft });
      onSubmitted?.();
    } catch (cause) {
      setError(workbenchErrorText(t, (key) => i18n.exists(key), cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const draftTarget = () => { const state = useWorkbenchStore.getState(); return JSON.stringify([state.selectedConversationId, state.draft.kind, state.draft.model, state.draft.channelModeId]); };
  const replaceSlots = (referenceSlots: Record<string, string[]>) => {
    if (!activeMode) return;
    const current = useWorkbenchStore.getState().draft;
    const remaining = current.references ?? [];
    const prompt = rebaseWorkbenchReferenceTokens(promptDraft.read(), [...workbenchSlotReferences(activeMode.slots, current.referenceSlots ?? {}), ...remaining], [...workbenchSlotReferences(activeMode.slots, referenceSlots), ...remaining]);
    promptDraft.flush(prompt); setDraft({ referenceSlots, prompt });
  };
  const addReferences = (additions: WorkbenchReference[]) => {
    promptDraft.flush();
    useWorkbenchStore.getState().addReferences(additions);
  };
  const addFiles = async (files: FileList | File[]) => {
    const target = draftTarget();
    setError("");
    const list = Array.from(files);
    if (!list.every(isReferenceFile)) {
      setError(t("rework.references"));
      return;
    }
    try {
      const additions = await Promise.all(list.map(readReferenceFile));
      if (draftTarget() === target) addReferences(additions);
    } catch (cause) {
      setError(workbenchErrorText(t, (key) => i18n.exists(key), cause));
    }
  };
  const replaceReferences = (next: WorkbenchReference[]) => {
    const current = useWorkbenchStore.getState().draft;
    const slotted = modes && activeMode ? workbenchSlotReferences(activeMode.slots, current.referenceSlots ?? {}) : [];
    const prompt = rebaseWorkbenchReferenceTokens(promptDraft.read(), [...slotted, ...(current.references ?? [])], [...slotted, ...next]);
    promptDraft.flush(prompt); setDraft({ references: next, prompt });
  };
  const assignReference = (referenceId: string, slotKey: string) => {
    if (!activeMode) return;
    const current = { ...useWorkbenchStore.getState().draft, prompt: promptDraft.read() };
    const next = assignWorkbenchReferenceToSlot(current, activeMode.slots, referenceId, slotKey);
    if (next === current) { setError(t('ui.workbench.referenceNotAdded')); return; }
    setError('');
    promptDraft.flush(next.prompt);
    setDraft({ prompt: next.prompt, referenceSlots: next.referenceSlots, references: next.references });
  };
  const setConfig = (patch: Partial<NonNullable<typeof draft.config>>) =>
    setDraft({ config: { ...draft.config, ...patch } });
  const changeMode = (modeId: string | undefined) => {
    if (!native) return;
    const current = useWorkbenchStore.getState().draft;
    const previousMode = activeMode ?? resolveModelModeOrFirst(native.model, current.channelModeId);
    const references = [...workbenchSlotReferences(previousMode.slots, current.referenceSlots ?? {}), ...(current.references ?? [])];
    const prompt = promptDraft.read();
    promptDraft.flush(prompt);
    // Keep all images visible when manually switching to a mode without compatible slots.
    setDraft({ prompt, channelModeId: modeId, references, referenceSlots: undefined });
  };
  const selectModel = (modelId: string, kind = draft.kind) => {
    const nextReferences = promptReferences;
    const prompt = rebaseWorkbenchReferenceTokens(promptDraft.read(), promptReferences, nextReferences);
    promptDraft.flush(prompt);
    setDraft({ kind, prompt, model: modelId, references: nextReferences, config: {}, channelModeId: undefined, referenceSlots: undefined });
  };
  const addSlotFiles = async (slot: RefSlot, files: File[]) => {
    const target = draftTarget();
    setError("");
    const accepted = files.filter((file) => file.type.startsWith(`${slot.kind}/`));
    if (accepted.length !== files.length) {
      setError(t("channelModes.wrongKind", { slot: slot.label }));
      return;
    }
    try {
      const read = await Promise.all(accepted.map(readReferenceFile));
      if (draftTarget() !== target) return;
      const current = useWorkbenchStore.getState().draft.referenceSlots ?? {};
      const sources = [...(current[slot.key] ?? []), ...read.map((reference) => reference.source)].slice(0, slot.max);
      replaceSlots({ ...current, [slot.key]: sources });
    } catch (cause) {
      setError(workbenchErrorText(t, (key) => i18n.exists(key), cause));
    }
  };
  /** Library drags carry ids only: re-read the asset/task so the reference uses the durable source. */
  const addDropped = async (payload: StudioMediaDrag) => {
    const target = draftTarget();
    setError("");
    try {
      if (payload.kind === "workbench-result") {
        const result = useWorkbenchStore.getState().tasks[payload.taskId]?.results[payload.resultIndex];
        const kind = result?.kind;
        if (!result || (kind !== "image" && kind !== "video" && kind !== "audio")) return;
        addReferences([{ id: crypto.randomUUID(), kind, source: result.source }]);
        return;
      }
      const assets = await listAssets();
      if (draftTarget() !== target) return;
      addReferences(payload.assetIds.flatMap((id): WorkbenchReference[] => {
        const asset = assets.find((entry) => entry.id === id);
        const kind = asset?.kind;
        return asset && (kind === "image" || kind === "video" || kind === "audio")
          ? [{ id: crypto.randomUUID(), kind, source: asset.source, name: asset.name }]
          : [];
      }));
    } catch (cause) {
      setError(workbenchErrorText(t, (key) => i18n.exists(key), cause));
    }
  };
  return (
    <div
      ref={root}
      className="studio-composer vm-composer"
      data-collapsed={collapsed || undefined}
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files") && !hasStudioMediaDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        setDragging(false);
        const library = readStudioMediaDrag(event.dataTransfer);
        if (library) {
          event.preventDefault();
          void addDropped(library);
          return;
        }
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }
      }}
    >
      {collapsed ? <div className="vm-composer-mini"><button type="button" aria-label={t('ui.workbench.expandComposer')} onClick={() => setCollapsed(false)}><BookText size={18} /><span>{promptDraft.value || t('rework.promptHint')}</span><small>{model?.label}</small></button><button type="button" className="studio-send" aria-label={t('rework.generate')} disabled={busy || validation.blocking || !model?.usable} onClick={() => void send()}><ArrowUp size={18} /></button></div> : <>
      <div className="vm-composer-main">
        <div className="vm-side-tools">
          <button type="button" onClick={() => setPicker('assets')}><FolderOpen size={17} /><span>{t('ui.workbench.sideAssets')}</span></button>
          <button type="button" onClick={(event) => togglePanel('info', event.currentTarget)}><Info size={17} /><span>{t('ui.workbench.sideInfo')}</span></button>
          <button type="button" onClick={(event) => togglePanel('presets', event.currentTarget)}><BookText size={17} /><span>{t('ui.workbench.sidePresets')}</span></button>
        </div>
        <div className="vm-reference-stack" hidden={Boolean(modes) && !autoImage && !draft.references?.length}>
          {(draft.references?.length ?? 0) > 0 && <button type="button" className="vm-stack-preview" title={t('ui.workbench.manageReferences')} aria-label={t('ui.workbench.manageReferences')} onClick={(event) => togglePanel('refs', event.currentTarget)}>{draft.references?.slice(0, 3).map((reference, index) => <span key={reference.id} style={{ transform: `translateX(${index * 8}px) rotate(${(index - 1) * 5}deg)` }}>{reference.kind === 'image' ? <AssetMedia source={reference.source} kind="image" className="h-full w-full object-cover" /> : <Film size={18} />}</span>)}<b>{draft.references?.length}</b></button>}
          <button
            type="button"
            className="studio-ref-tile"
            title={t("rework.addReference")}
            aria-label={t("rework.addReference")}
            aria-haspopup="menu"
            aria-expanded={refMenu ? true : undefined}
            onClick={(event) => setRefMenu(refMenu ? null : anchorAbove(event.currentTarget))}
          >
            <ImagePlus className="h-[18px] w-[18px]" />
          </button>
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
        </div>
      {modes && activeMode?.slots.length ? (
        <>
          <ChannelModeControls
            className="vm-frame-slots vm-frame-slots--inline"
            modes={[activeMode]}
            active={activeMode}
            onModeChange={changeMode}
            slots={draft.referenceSlots ?? {}}
            onSlotsChange={replaceSlots}
            onAddToSlot={(slot) => {
              setPendingSlot(slot);
              if (slotInput.current) {
                slotInput.current.accept = `${slot.kind}/*`;
                slotInput.current.multiple = slot.max - (draft.referenceSlots?.[slot.key]?.length ?? 0) > 1;
                slotInput.current.click();
              }
            }}
            renderSource={(source, slot) => slot.kind === "image"
              ? <AssetMedia source={source} kind="image" alt={slot.label} className="h-full w-full object-cover" />
              : slot.kind === "video" ? <Film className="h-4 w-4" /> : <AudioLines className="h-4 w-4" />}
          />
          <input
            ref={slotInput}
            type="file"
            hidden
            onChange={(event) => {
              const files = event.target.files ? Array.from(event.target.files) : [];
              event.target.value = "";
              if (pendingSlot && files.length) void addSlotFiles(pendingSlot, files);
            }}
          />
        </>
      ) : null}
        <div className="min-w-0 flex-1"><PromptEditor referencePickerRequest={mentionRequest} onUploadReference={() => input.current?.click()} onChooseAsset={() => setPicker('assets')} draft={promptDraft} references={references} pickable={references}
          placeholder={t(draft.kind === 'audio' ? 'ui.workbench.audioPromptHint' : draft.kind === 'chat' ? 'ui.workbench.chatPromptHint' : 'ui.workbench.desktopPromptHint')} submitOnEnter onSubmit={() => void send()}
          slashCommands={materials.filter((entry) => entry.enabled).map((entry) => ({ id: entry.id, label: entry.name, hint: entry.kind, run: () => promptDraft.flush(applyMaterialToPrompt(promptDraft.read(), entry)) }))}
          resolvePastedImage={(event) => Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/')) ?? null}
          onPasteImage={async (file) => { await addFiles([file]); return null; }} />
        </div>
      </div>
      <div className="vm-composer-toolbar">
        <div className="vm-composer-controls">
        <button type="button" className="vm-composer-chip text-accent" onClick={(event) => togglePanel('type', event.currentTarget)}>{draft.kind === 'video' ? <Film /> : draft.kind === 'audio' ? <AudioLines /> : draft.kind === 'chat' ? <MessageSquareText /> : <Images />}<span>{t(`rework.${draft.kind}`)}</span><ChevronDown /></button>
        <ModelChoice
          models={models}
          value={selectedModelId}
          onChange={(id) => selectModel(id)}
        />
        {modes && activeMode && <button type="button" className="vm-composer-chip" onClick={(event) => togglePanel('mode', event.currentTarget)}><Layers /><span>{autoImage ? `${t('ui.channels.autoImage.auto')} · ${activeMode.mode.label}` : activeMode.mode.label}</span><ChevronDown /></button>}
        <button type="button" className="vm-composer-chip" onClick={(event) => togglePanel('params', event.currentTarget)}><SlidersHorizontal /><span>{[draft.config?.aspectRatio, draft.config?.size, draft.config?.seconds ? `${draft.config.seconds}s` : '', ...(parameterSummary(activeMode?.params ?? [], draft.config?.extraParams ?? {}))].filter(Boolean).join(' · ') || t('ui.workbench.parameters')}</span></button>
        <button type="button" className="vm-composer-chip" aria-label="引用参考素材" title="引用参考素材" onClick={() => setMentionRequest((value) => value + 1)}><AtSign /></button>
        </div>
        <button type="button" className="vm-composer-collapse" title={t('ui.workbench.collapseComposer')} aria-label={t('ui.workbench.collapseComposer')} onClick={() => setCollapsed(true)}><ChevronDown size={17} /></button>
        <button
          type="button"
          disabled={busy || !promptDraft.value.trim() || !model?.usable || validation.blocking}
          title={hints[0] ? validationIssueText(t, hints[0]) : undefined}
          onClick={() => void send()}
          aria-label={t("rework.generate")}
          className="studio-send h-9 w-9 max-md:ml-auto"
        >
          <ArrowUp className={`h-[18px] w-[18px] ${busy ? "animate-pulse" : ""}`} />
        </button>
      </div>
      {hints.length > 0 && (
        <ul role="status" aria-label={t("rework.refMenu.constraints")} className="mt-2 space-y-0.5 rounded-[var(--r-md)] border border-warning/25 bg-warning/8 px-3 py-1.5 text-[11.5px] leading-5 text-text-dark">
          {hints.map((issue, index) => <li key={`${issue.code}:${issue.slotKey ?? issue.paramKey ?? index}`}>{validationIssueText(t, issue)}</li>)}
        </ul>
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
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
      </>}
      {panel && <PopoverSurface anchor={panel.anchor} width={panel.kind === 'params' ? 420 : 380} onClose={() => setPanel(null)} className="vm-composer-popover" label={t(`ui.workbench.panel.${panel.kind}`)}>
        <header className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">{t(`ui.workbench.panel.${panel.kind}`)}</h3><button type="button" aria-label={t('common.close')} onClick={() => setPanel(null)}><X size={16} /></button></header>
        {panel.kind === 'type' && KINDS.map((entry) => <button key={entry.id} type="button" className="ui-menu__item" onClick={() => { if (draft.kind !== entry.id) selectModel('', entry.id); setPanel(null); }}><entry.icon size={18} />{t(`rework.${entry.id}`)}</button>)}
        {panel.kind === 'mode' && canAutoImage && <button type="button" className="ui-menu__item" onClick={() => { changeMode(undefined); setPanel(null); }}><span><b className="block text-sm font-medium">{t('ui.channels.autoImage.auto')}</b><small className="text-text-subtle">{t('ui.channels.autoImage.hint')}</small></span></button>}
        {panel.kind === 'mode' && modes?.map((entry) => <button key={entry.mode.id} type="button" className="ui-menu__item" onClick={() => { changeMode(entry.mode.id); setPanel(null); }}><span><b className="block text-sm font-medium">{entry.mode.label}</b><small className="text-text-subtle">{entry.mode.description}</small></span></button>)}
        {panel.kind === 'params' && (native && activeMode ? <ComposerParameterPanel params={activeMode.params} values={draft.config?.extraParams ?? {}} onChange={(extraParams) => setConfig({ extraParams })} /> : <div className="space-y-4">
          {model?.ratios.length ? <div><p className="mb-2 text-xs text-text-muted">{t('rework.ratio')}</p><div className="grid grid-cols-5 gap-1">{model.ratios.map((ratio) => <button key={ratio} type="button" className="vm-ratio" data-active={draft.config?.aspectRatio === ratio || undefined} onClick={() => setConfig({ aspectRatio: ratio })}><span style={{ aspectRatio: ratio.replace(':','/'), width: ratio==='9:16'?10:18, maxHeight:20 }} />{ratio}</button>)}</div></div> : null}
          {!!model?.resolutions.length && <label className="block text-xs text-text-muted">{t('rework.resolution')}<UiSelect value={draft.config?.size ?? ''} onChange={(event) => setConfig({ size: event.target.value || undefined })}><option value="">{t('ui.workbench.default')}</option>{model.resolutions.map((size) => <option key={size}>{size}</option>)}</UiSelect></label>}
          {!!model?.durations.length && <label className="block text-xs text-text-muted">{t('rework.seconds')}<UiSelect value={draft.config?.seconds === undefined ? '' : String(draft.config.seconds)} onChange={(event) => setConfig({ seconds: event.target.value ? Number(event.target.value) : undefined })}><option value="">{t('ui.workbench.default')}</option>{model.durations.map((duration) => <option key={duration}>{duration}</option>)}</UiSelect></label>}
          {!model?.ratios.length && !model?.resolutions.length && !model?.durations.length && <p className="text-sm text-text-muted">{t('ui.workbench.noParameters')}</p>}
        </div>)}
        {panel.kind === 'info' && <div className="space-y-3 text-sm"><h4 className="font-medium">{model?.label || t('rework.model')}</h4><p className="text-text-muted">{model?.provider}</p><p className="text-xs leading-6 text-text-muted">{limitParts.length ? limitParts.join(' · ') : t('rework.refMenu.limitUnknown')}</p>{native?.profile.notes?.map((note,index) => <p key={index} className="text-xs leading-6 text-text-subtle">{note}</p>)}<UiButton variant="secondary" onClick={() => { setPanel(null); onSettings(); }}>{t('rework.settings')}</UiButton></div>}
        {panel.kind === 'presets' && <div><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={t('rework.search')} aria-label={t('rework.search')} className="ui-input w-full px-3" /><div className="ui-scrollbar mt-2 max-h-72 overflow-y-auto">{materials.filter((entry) => entry.enabled && `${entry.name} ${entry.prompt}`.toLowerCase().includes(presetSearch.toLowerCase())).map((entry) => <button key={entry.id} type="button" className="ui-menu__item" onClick={() => { promptDraft.flush(applyMaterialToPrompt(promptDraft.read(), entry)); setPanel(null); }}><span className="min-w-0"><span className="block text-sm">{entry.name}</span><span className="line-clamp-2 text-xs text-text-subtle">{entry.prompt}</span></span></button>)}</div></div>}
        {panel.kind === 'refs' && modes && activeMode && <ChannelModeControls modes={[activeMode]} active={activeMode} onModeChange={changeMode} slots={draft.referenceSlots ?? {}} onSlotsChange={replaceSlots} onAddToSlot={(slot) => { setPendingSlot(slot); if (slotInput.current) { slotInput.current.accept = `${slot.kind}/*`; slotInput.current.multiple = slot.max > 1; slotInput.current.click(); } }} renderSource={(source,slot) => <AssetMedia source={source} kind={slot.kind} className="h-full w-full object-cover" />} />}
        {panel.kind === 'refs' && modes && activeMode && !!draft.references?.length && <section className="mt-4 space-y-2 border-t border-border-dark pt-3">
          <h4 className="text-xs font-medium">{t('ui.workbench.unassignedReferences')}</h4>
          <p className="text-xs leading-5 text-text-muted">{t('ui.workbench.assignReferenceHint')}</p>
          <div className="ui-scrollbar max-h-64 space-y-2 overflow-y-auto">
            {draft.references.map(reference => {
              const mention = references.find(entry => entry.sourceNodeId === reference.id);
              const compatible = activeMode.slots.filter(slot => slot.kind === reference.kind);
              return <div key={reference.id} role="group" aria-label={reference.name ?? mention?.label} className="rounded-[var(--r-md)] border border-border-dark p-2">
                <div className="flex items-center gap-2">
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[var(--r-sm)] bg-raised">
                    {reference.kind === 'text' ? <BookText className="m-2 h-6 w-6 text-text-muted" /> : <AssetMedia source={reference.source} kind={reference.kind} className="h-full w-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1"><p className="truncate text-xs">{reference.name ?? mention?.label}</p><span className="text-[11px] text-text-subtle">{mention?.token}</span></div>
                  <UiButton variant="ghost" size="sm" aria-label={t('rework.removeReference')} title={t('rework.removeReference')} onClick={() => replaceReferences((useWorkbenchStore.getState().draft.references ?? []).filter(entry => entry.id !== reference.id))}><X size={14} /></UiButton>
                </div>
                {reference.kind !== 'text' && <div className="mt-2 flex flex-wrap gap-1.5">
                  {compatible.map(slot => {
                    const full = (draft.referenceSlots?.[slot.key]?.length ?? 0) >= slot.max;
                    return <UiButton key={slot.key} variant="secondary" size="sm" disabled={full} title={full ? t('ui.workbench.referenceSlotFull') : undefined} onClick={() => assignReference(reference.id, slot.key)}>{t('ui.workbench.assignReference', { slot: slot.label })}{full ? ` · ${t('ui.workbench.referenceSlotFull')}` : ''}</UiButton>;
                  })}
                  {!compatible.length && <p className="text-xs leading-5 text-warning">{t('ui.workbench.noCompatibleReferenceSlot')}</p>}
                </div>}
              </div>;
            })}
          </div>
        </section>}
        {panel.kind === 'refs' && !modes && <div><p className="mb-3 text-xs text-text-muted">{t('ui.workbench.referenceReorder')}</p><div className="flex flex-wrap gap-2">{draft.references?.map((reference,index) => <div key={reference.id} draggable onDragStart={() => { draggingRef.current = index; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const from = draggingRef.current; if (from === null) return; const next=[...(draft.references ?? [])];const [entry]=next.splice(from,1);next.splice(index,0,entry);replaceReferences(next);draggingRef.current=null; }} className="vm-reference-tile"><AssetMedia kind={reference.kind === 'text' ? 'image' : reference.kind} source={reference.source} className="h-full w-full object-cover" /><span>{references.find((entry) => entry.sourceNodeId === reference.id)?.label}</span><button type="button" title={t('rework.removeReference')} aria-label={t('rework.removeReference')} onClick={() => replaceReferences((draft.references ?? []).filter((entry) => entry.id!==reference.id))}><X size={12} /></button></div>)}</div><div className="mt-4 flex gap-2"><UiButton icon={<Upload />} variant="secondary" onClick={() => input.current?.click()}>{t('rework.refMenu.local')}</UiButton><UiButton icon={<FolderOpen />} variant="secondary" onClick={() => { setPanel(null); setPicker('assets'); }}>{t('ui.workbench.sideAssets')}</UiButton></div>{!draft.references?.length && <p className="mt-3 text-xs text-text-subtle">{t('ui.workbench.noReferences')}</p>}</div>}
      </PopoverSurface>}
      {refMenu && (
        <MenuSurface anchor={refMenu} onClose={() => setRefMenu(null)} width={260} label={t("rework.addReference")}>
          <MenuItem icon={<Upload />} label={t("rework.refMenu.local")} onClick={() => { setRefMenu(null); input.current?.click(); }} />
          <MenuItem icon={<FolderOpen />} label={t("rework.refMenu.assets")} onClick={() => { setRefMenu(null); setPicker("assets"); }} />
          <MenuItem icon={<LayoutGrid />} label={t("rework.refMenu.canvas")} onClick={() => { setRefMenu(null); setPicker("canvas"); }} />
          <MenuSeparator />
          <p className="px-3 pb-1.5 pt-0.5 text-[11px] leading-4 text-text-subtle">
            {limitParts.length ? limitParts.join(" · ") : t("rework.refMenu.limitUnknown")}
          </p>
        </MenuSurface>
      )}
      {picker && (
        <AssetPickerDialog
          source={picker}
          accept={REFERENCE_KINDS.filter((kind) => limits[kind] !== 0)}
          remaining={remaining}
          onPick={(assets) => {
            setError("");
            try { addReferences(assets.map((asset) => ({ id: crypto.randomUUID(), kind: asset.kind, source: asset.source, name: asset.name }))); }
            catch (cause) { setError(workbenchErrorText(t, (key) => i18n.exists(key), cause)); }
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
