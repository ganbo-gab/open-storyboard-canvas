import { AgentContextDetails, formatAgentContextPercent } from './AgentContextDetails';
import { useAgentContextUsage, estimateAgentTextTokens } from '@/features/canvas/agent/application/agentContextUsage';
import { MAX_AGENT_MEDIA_ATTACHMENTS, validateAgentImageFile } from '@/features/canvas/agent/application/agentMediaResolver';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, BookOpen, ChevronRight, Gauge, MessageSquarePlus, Paperclip, Settings2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UiButton, UiIconButton, UiSelect } from "@/components/ui";
import { getScopedAgentSession } from "../application/scopedAgentSession";
import type { AgentTurnMediaInput } from "@/features/canvas/agent/domain/agentModel";
import { useProjectStore } from "@/stores/projectStore";
import { saveAsset, getAssetPortableSource } from "@/features/assets/application/assetCatalog";
import { openSettingsDialog } from "@/features/settings/settingsEvents";
import { mergeTurnMedia, useAgentComposerAssist } from "./useAgentComposerAssist";
import { takeHomeAgentMessage } from "./homeAgentHandoff";
import { AgentCanvasPlanPreview, AgentChannelProfileSummary } from "./AgentApprovalPreview";
import { AgentApprovalCard } from "./AgentApprovalCard";
import {
  AgentComposer,
  AgentComposerPopover,
  AgentComposerTool,
  AgentModeOptions,
  AgentModelOptions,
  AgentModelPill,
} from "./AgentComposer";
import { AgentEmptyState, AgentMessage, AgentNotice, AgentReasoning, agentToolTitle } from "./AgentThread";
import { AgentToolStep, agentToolFailureText } from "./AgentToolStep";
import { readableAgentFailure } from "./agentFailureText";
import { AgentFailureNotice } from './AgentFailureNotice';
import { useConversationScroll } from './useConversationScroll';
import { useAgentTurnSelection } from "./useAgentTurnSelection";

type Props = {
  scope: "home" | "stage";
  projectId?: string;
  onSettings?: () => void;
  compact?: boolean;
  onClose?: () => void;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ScopedAgentPanel({ scope, projectId, onSettings, compact = false, onClose }: Props) {
  const { t } = useTranslation();
  const activeProjectId = useProjectStore((state) => state.currentProjectId);
  const effectiveProjectId = scope === "home" ? undefined : (projectId ?? activeProjectId ?? undefined);
  const service = useMemo(
    () => getScopedAgentSession({ scope, projectId: effectiveProjectId }),
    [scope, effectiveProjectId],
  );
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  // Turn boundaries rewrite the saved conversation's model/mode; re-read it when they pass.
  const selection = useAgentTurnSelection(state.sessionId, `${state.status}:${state.messages.length}`);
  const model = selection.model;
  const savedContextUsage = useAgentContextUsage(state.sessionId);
  const contextUsage = savedContextUsage?.modelId === model?.id ? savedContextUsage : undefined;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [media, setMedia] = useState<AgentTurnMediaInput[]>([]);
  const [menu, setMenu] = useState<"models" | "mode" | "context" | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const draftOwner = `${scope}:${effectiveProjectId ?? 'home'}:${state.sessionId ?? 'new'}:${draftEpoch}`;
  const ownerRef = useRef({ key: draftOwner, mounted: true });
  ownerRef.current.key = draftOwner;
  const serviceRef = useRef(service); serviceRef.current = service;
  const preparingSend = useRef(false);
  useEffect(() => {
    ownerRef.current.mounted = true;
    return () => { ownerRef.current.mounted = false; };
  }, []);
  useEffect(() => { setAttachmentBusy(false); setUploading(false); uploadInFlight.current = false; }, [draftOwner]);
  useEffect(() => { setMedia([]); setDraft(''); }, [service, scope, effectiveProjectId]);
  const scrollVersion = `${state.messages.length}:${state.liveText}:${state.approvals.length}:${state.toolEvents.length}:${state.reasoningSummary}`;
  const { scrollRef: scroll, onScroll, showNewItems, jumpToLatest } = useConversationScroll(state.sessionId, scrollVersion);
  const editor = useRef<HTMLTextAreaElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const assist = useAgentComposerAssist({ scope, projectId: effectiveProjectId, text: draft, setText: setDraft, textareaRef: editor });
  const running = state.status === "running";
  const awaitingApproval = state.approvals.length > 0;
  const cancelable = running || state.status === "awaiting-approval";
  const openSettings = onSettings ?? (() => openSettingsDialog({ category: "providersChat" }));
  const visionBlocked = media.length > 0 && Boolean(model) && !model?.supportsMultimodal;

  // Only a fresh idle instance adopts the latest history; remounts keep a running or waiting turn.
  useEffect(() => {
    const snapshot = service.getSnapshot();
    if (snapshot.sessionId || snapshot.status !== "idle") return;
    const sessions = service.listSessions();
    if (!sessions[0]) return;
    try {
      service.loadSession(sessions[0].id);
    } catch (cause) {
      setError(readableAgentFailure(cause, t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const sendText = async (text: string) => {
    if (!model || !text.trim() || running || awaitingApproval || uploadInFlight.current || attachmentBusy || preparingSend.current) return;
    const owner = draftOwner;
    const isCurrent = () => ownerRef.current.mounted && ownerRef.current.key === owner;
    preparingSend.current = true;
    let accepted = false;
    setError("");
    setNotice("");
    setDraft("");
    setMenu(null);
    jumpToLatest();
    try {
      const prepared = await assist.prepare(text);
      if (!isCurrent()) return;
      const turnMedia = mergeTurnMedia(media, prepared.media);
      if (turnMedia.length && !model.supportsMultimodal) {
        setError(t("canvasAgent.switchToVisionModelHint"));
        setDraft(text);
        return;
      }
      const portableMedia = await Promise.all(turnMedia.map(async (item) => ({
        ...item,
        source: await getAssetPortableSource(item.source),
      })));
      if (!isCurrent()) return;
      const explicitSkillIds = assist.explicitSkillIds;
      const sent = service.send({
        message: prepared.message,
        model,
        executionMode: selection.executionMode,
        media: portableMedia,
        ...(explicitSkillIds.length ? { explicitSkillIds } : {}),
      });
      accepted = service.getSnapshot().status === 'running';
      if (accepted) { setMedia([]); assist.markSent(explicitSkillIds); assist.reset(); }
      await sent;
    } catch (cause) {
      if (isCurrent()) { setError(readableAgentFailure(cause, t)); if (!accepted) setDraft(text); }
    } finally { preparingSend.current = false; }
  };

  const continueRun = async () => {
    if (!model || running || awaitingApproval || preparingSend.current || !state.sessionId) return;
    setError(''); setNotice(''); jumpToLatest();
    try {
      await service.send({ message: t('ui.agent.continuePrompt'), model, executionMode: selection.executionMode });
    } catch (cause) { setError(readableAgentFailure(cause, t)); }
  };

  // The home composer hands its message over once; a fresh conversation keeps unrelated ideas apart.
  useEffect(() => {
    if (scope !== "home") return;
    const handoff = takeHomeAgentMessage();
    if (!handoff) return;
    const status = service.getSnapshot().status;
    if (status === "running" || status === "awaiting-approval" || !model) {
      setDraft(handoff);
      setNotice(t(model ? "rework.agent.handoffBusy" : "rework.agent.handoffNeedsModel"));
      return;
    }
    service.newSession();
    void sendText(handoff);
    // Run once per mounted conversation; later model/state changes must never resend the handoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);


  const closeMenu = () => {
    setMenu(null);
    requestAnimationFrame(() => menuTrigger.current?.focus());
  };
  const toggleMenu = (next: "models" | "mode" | "context", trigger: HTMLButtonElement) => {
    menuTrigger.current = trigger;
    setMenu((current) => (current === next ? null : next));
  };

  const decide = (approvalId: string, approve: boolean) => {
    if (!model || running || deciding) return;
    setError("");
    setDeciding({ id: approvalId, approve });
    void service
      .resolveApproval({ approvalId, approve, model })
      .catch((cause: unknown) => setError(readableAgentFailure(cause, t)))
      .finally(() => setDeciding(null));
  };

  const attachFiles = async (files: File[]) => {
    if (uploadInFlight.current || preparingSend.current || !ownerRef.current.mounted) return;
    if (service.getSnapshot().status === 'running' || service.getSnapshot().status === 'awaiting-approval') return;
    if (files.length + media.length > MAX_AGENT_MEDIA_ATTACHMENTS) throw new Error(`最多添加 ${MAX_AGENT_MEDIA_ATTACHMENTS} 张图片。`);
    const sessionId = service.getSnapshot().sessionId;
    const owner = draftOwner;
    const isCurrent = () => ownerRef.current.mounted && ownerRef.current.key === owner && service.getSnapshot().sessionId === sessionId;
    uploadInFlight.current = true; setUploading(true);
    try {
      const added: AgentTurnMediaInput[] = [];
      for (const file of files) {
        await validateAgentImageFile(file);
        if (!isCurrent()) return;
        const source = await readFileAsDataUrl(file);
        if (!isCurrent()) return;
        const asset = await saveAsset({ kind: 'image', source, name: file.name, origin: 'uploaded', metadata: { mime: file.type } });
        if (!isCurrent()) return;
        added.push({ assetId: asset.id, title: asset.name, origin: 'upload', source: asset.source, mimeType: file.type });
      }
      if (isCurrent()) setMedia((current) => mergeTurnMedia(current, added));
    } catch (cause) {
      if (isCurrent()) throw cause;
    } finally { if (isCurrent()) { uploadInFlight.current = false; setUploading(false); } }
  };

  const lastMessage = state.messages[state.messages.length - 1];
  const splitLastReply = !running && lastMessage?.role === "assistant" && state.toolEvents.length > 0;
  const leadingMessages = splitLastReply ? state.messages.slice(0, -1) : state.messages;
  const trailingMessage = splitLastReply ? lastMessage : undefined;
  const toolSteps = state.toolEvents.length ? (
    <div className="min-w-0">
      {!running ? (
        <button type="button" className="agent-disclosure" aria-expanded={toolsOpen} onClick={() => setToolsOpen((value) => !value)}>
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${toolsOpen ? "rotate-90" : ""}`} aria-hidden="true" />
          {t("rework.agent.tools", { count: state.toolEvents.length })}
        </button>
      ) : null}
      {running || toolsOpen ? (
        <div className={running ? "flex flex-col gap-0.5" : "agent-step-body flex flex-col gap-0.5"}>
          {state.toolEvents.map((event, index) => (
            <AgentToolStep
              key={event.callId ?? `${event.toolName}-${index}`}
              title={agentToolTitle(t, event.toolName)}
              status={event.status}
              raw={event.output ?? event.input ?? event.error}
              failure={agentToolFailureText(event.status, event.error, event.output)}
              compactFailure={!running || index < state.toolEvents.length - 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  ) : null;

  const hint = awaitingApproval
    ? t("canvasAgent.resolveApprovalHint")
    : visionBlocked
      ? t("canvasAgent.switchToVisionModelHint")
      : !model && selection.models.length
        ? t("rework.agent.selection.chooseHint")
        : null;

  const modelMenu = menu === "models" ? (
    <AgentComposerPopover title={t("canvasAgent.modelMenuTitle")} onClose={closeMenu}>
      <AgentModelOptions
        icon={<Sparkles className="h-3.5 w-3.5" />}
        title={t("canvasAgent.textModels")}
        entries={selection.models}
        selectedId={model?.id ?? null}
        onChange={(id) => { selection.selectModel(id); closeMenu(); }}
        emptyLabel={t("canvasAgent.noTextModels")}
      />
      <UiButton variant="secondary" className="mt-2 min-h-10 w-full gap-2 text-xs" onClick={() => { setMenu(null); openSettings(); }}>
        <Settings2 className="h-3.5 w-3.5" />
        {t("canvasAgent.manageModels")}
      </UiButton>
    </AgentComposerPopover>
  ) : menu === "mode" ? (
    <AgentComposerPopover title={t("canvasAgent.executionMode")} onClose={closeMenu}>
      <AgentModeOptions value={selection.executionMode} onChange={(mode) => { selection.selectMode(mode); closeMenu(); }} />
    </AgentComposerPopover>
  ) : menu === "context" ? (
    <AgentComposerPopover title={t('canvasAgent.contextUsage')} onClose={closeMenu}>
      <AgentContextDetails usage={contextUsage} contextWindow={model?.contextWindow} modelId={model?.id} draftTokens={estimateAgentTextTokens(draft) + media.length * 1000} />
    </AgentComposerPopover>
  ) : null;

  return (
    <section className={`agent-workspace flex h-full min-h-0 flex-col ${compact ? "bg-surface" : "mx-auto w-full"}`}>
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4">
        <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-dark">{t(`rework.agent.${scope}`)}</h2>
        <UiSelect
          aria-label={t("rework.history")}
          value={state.sessionId ?? ""}
          disabled={cancelable || uploading || attachmentBusy}
          onChange={(event) => {
            try {
              service.loadSession(event.target.value);
              setDraftEpoch((value) => value + 1);
              setDraft(""); setMedia([]); assist.reset();
              setError("");
            } catch (cause) {
              setError(readableAgentFailure(cause, t));
            }
          }}
          className="h-8 w-28 max-w-40 text-xs"
        >
          <option value="">{t("rework.history")}</option>
          {service.listSessions().map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </UiSelect>
        <UiIconButton
          disabled={cancelable || uploading || attachmentBusy}
          title={t("rework.conversation")}
          aria-label={t("rework.conversation")}
          onClick={() => {
            service.newSession();
            setDraftEpoch((value) => value + 1);
            setDraft(""); setMedia([]); assist.reset();
            setError("");
            setNotice("");
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </UiIconButton>
        {onClose && <UiIconButton aria-label={t('common.close')} title={t('common.close')} className="ml-1 shrink-0" onClick={onClose}><X className="h-4 w-4" /></UiIconButton>}
      </header>
      <div ref={scroll} onScroll={onScroll} className="agent-conversation-scroll ui-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5"><div className="agent-conversation-column">
        {!state.messages.length && !running ? (
          <AgentEmptyState
            icon={<Sparkles className="h-7 w-7" />}
            title={t(`ui.agent.${scope}Title`)}
            description={t(`ui.agent.${scope}Hint`)}
            action={model ? undefined : selection.models.length ? (
              <UiButton variant="secondary" className="min-h-10 gap-2 text-xs" onClick={() => setMenu("models")}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {t("rework.agent.selection.choose")}
              </UiButton>
            ) : (
              <UiButton variant="primary" className="min-h-10 gap-2 text-xs" onClick={openSettings}>
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t("canvasAgent.configureModel")}
              </UiButton>
            )}
          />
        ) : null}
        {!state.messages.length && !running && <div className="agent-starters">{(scope === 'home' ? ['suggestStory', 'suggestCharacter'] : ['suggestStage']).map((key) => <button key={key} type="button" className="agent-suggestion" onClick={() => { setDraft(t(`ui.agent.${key}`)); editor.current?.focus(); }}><Sparkles size={16} />{t(`ui.agent.${key}`)}</button>)}</div>}
        <div className="agent-thread">
          {leadingMessages.map((item, index) => (
            <AgentMessage key={`${item.createdAt}-${index}`} role={item.role} text={item.text} attachments={item.mediaReferences} />
          ))}
          {state.reasoningSummary ? (
            <AgentReasoning
              summary={state.reasoningSummary.length > 96 ? `${state.reasoningSummary.slice(0, 96).trimEnd()}…` : state.reasoningSummary}
              detail={state.reasoningSummary}
              live={running}
            />
          ) : null}
          {toolSteps}
          {trailingMessage ? (
            <AgentMessage role={trailingMessage.role} text={trailingMessage.text} attachments={trailingMessage.mediaReferences} />
          ) : null}
          {state.liveText ? <AgentMessage role="assistant" text={state.liveText} streaming={running} /> : null}
          {running && !state.liveText ? <AgentNotice tone="running">{t("canvasAgent.thinking")}</AgentNotice> : null}
          {state.status === "cancelled" ? <AgentNotice tone="cancelled">{t("canvasAgent.cancelled")}</AgentNotice> : null}
          {state.approvals.map((approval) => (
            <AgentApprovalCard
              key={approval.id}
              toolName={approval.toolName}
              questionBinding={{ projectId: state.projectId, runId: state.runId ?? '', callId: approval.id }}
              summary={approval.summary}
              impact={approval.impact}
              args={approval.arguments}
              status={deciding?.id === approval.id ? (deciding.approve ? "approving" : "rejecting") : "pending"}
              expiresAt={approval.expiresAt}
              disabled={!model || running || Boolean(deciding)}
              blockedReason={model ? null : t("rework.agent.selection.approvalNeedsModel")}
              preview={approval.toolName === "canvas_open_plan"
                ? <AgentCanvasPlanPreview args={approval.arguments} projectId={state.projectId} runId={state.runId} />
                : approval.toolName === "channel_create" || approval.toolName === "channel_update"
                  ? <AgentChannelProfileSummary args={approval.arguments} />
                  : null}
              onDecide={(approve) => decide(approval.id, approve)}
            />
          ))}
          {notice ? <AgentNotice tone="info">{notice}</AgentNotice> : null}
          {state.retry ? <AgentNotice tone="info">{t('ui.agent.retrying', { attempt: state.retry.attempt, total: state.retry.maxRetries })}</AgentNotice> : null}
          {error || state.error ? <AgentFailureNotice summary={state.error ? readableAgentFailure(state.failure ?? state.error, t) : error} detail={state.error ?? error} /> : null}
          {(state.status === 'error' || state.status === 'cancelled') && state.sessionId ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <UiButton variant="secondary" disabled={!model || running} onClick={() => { void continueRun(); }}>{t('ui.agent.continueRemaining')}</UiButton>
              <span>{t('ui.agent.continueHint')}</span>
            </div>
          ) : null}
        </div>
      </div>
      </div>
      <div className="agent-composer-column relative shrink-0 px-4 pb-4 pt-2">
        {showNewItems && <UiButton variant="secondary" className="workbench-jump" icon={<ArrowDown />} onClick={jumpToLatest}>{t('ui.agent.newMessages')}</UiButton>}
        <input
          type="file"
          hidden
          accept="image/*"
          ref={upload}
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []); event.target.value = '';
            if (files.length) void attachFiles(files).catch((cause: unknown) => setError(readableAgentFailure(cause, t)));
          }}
        />
        <AgentComposer
          key={draftOwner}
          value={draft}
          placeholder={t("rework.agent.placeholder")}
          textareaRef={editor}
          assist={assist}
          running={cancelable}
          submitDisabled={!model || !draft.trim() || awaitingApproval || visionBlocked || uploading}
          hint={hint}
          attachments={media}
          onAttachFiles={attachFiles}
          onAttachmentBusyChange={setAttachmentBusy}
          onRemoveAttachment={(assetId) => setMedia((current) => current.filter((item) => item.assetId !== assetId))}
          menu={modelMenu}
          tools={<>
            <AgentComposerTool
              label={model && !model.supportsMultimodal ? t("canvasAgent.visionRequired") : t("rework.upload")}
              disabled={uploading}
              onClick={() => { setMenu(null); upload.current?.click(); }}
            >
              <Paperclip />
            </AgentComposerTool>
            <AgentModelPill
              model={model}
              requestedModel={selection.requestedModel}
              issue={selection.modelIssue}
              source={selection.modelSource}
              open={menu === "models"}
              onClick={(event) => (selection.models.length ? toggleMenu("models", event.currentTarget) : openSettings())}
            />
            <AgentComposerTool label={t("rework.skills.pickerTitle")} expanded={assist.skillsOpen} onClick={() => { setMenu(null); assist.toggleSkills(); }}>
              <BookOpen />
            </AgentComposerTool>
            <AgentComposerTool label={t("canvasAgent.executionMode")} expanded={menu === "mode"} onClick={(event) => toggleMenu("mode", event.currentTarget)}>
              <Gauge />
              <span className="agent-pill__label">{t(`canvasAgent.executionModes.${selection.executionMode}.short`)}</span>
            </AgentComposerTool>
            <AgentComposerTool label={t('canvasAgent.contextUsage')} expanded={menu === 'context'} onClick={event => toggleMenu('context', event.currentTarget)}>
              <Gauge />
              <span className="text-[11px] tabular-nums">{contextUsage ? formatAgentContextPercent(contextUsage.usedTokens, model?.contextWindow) : '—'}</span>
            </AgentComposerTool>
          </>}
          onChange={setDraft}
          onSubmit={() => void sendText(draft)}
          onStop={() => service.stop()}
        />
      </div>
    </section>
  );
}
