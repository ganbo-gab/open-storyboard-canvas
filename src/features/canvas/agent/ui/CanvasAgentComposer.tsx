import { AgentContextDetails, formatAgentContextPercent } from '@/features/agents/ui/AgentContextDetails';
import type { AgentContextUsage } from '../application/agentContextUsage';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen, CircleAlert, Gauge, ImageIcon, Plus, Settings2, Type, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import {
  AgentComposer,
  AgentComposerPopover,
  AgentComposerTool,
  AgentModeOptions,
  AgentModelOptions,
  AgentModelPill,
  type AgentModelOption,
} from '@/features/agents/ui/AgentComposer';
import type { AgentComposerAssist } from '@/features/agents/ui/useAgentComposerAssist';
import type { AgentModelIssue, AgentSelectionSource } from '@/features/agents/ui/useAgentTurnSelection';
import type { CanvasAgentExecutionMode } from '../application/agentAutoApprovalPolicy';
import type { AgentTurnMediaInput } from '../domain/agentModel';

type ComposerMenu = 'models' | 'mode' | 'context' | null;

interface Props {
  /** Usable, tool-capable chat models offered for this turn. */
  textModels: AgentModelOption[];
  imageModels: AgentModelOption[];
  videoModels: AgentModelOption[];
  /** The model the next built-in turn really uses; null when the resolved choice cannot run. */
  selectedTextModel: (AgentModelOption & { supportsMultimodal?: boolean }) | null;
  requestedTextModel?: AgentModelOption | null;
  modelIssue?: AgentModelIssue | null;
  modelSource?: AgentSelectionSource;
  externalRuntime?: { label: string; ready: boolean };
  selectedImageModelId: string | null;
  selectedVideoModelId: string | null;
  executionMode: CanvasAgentExecutionMode;
  draft: string;
  attachments?: AgentTurnMediaInput[];
  maxAttachments?: number;
  hasMissingAttachments?: boolean;
  isRunning: boolean;
  hasPendingApproval: boolean;
  hasPendingPlan: boolean;
  contextEstimateTokens: number;
  contextUsage?: AgentContextUsage;
  contextDraftTokens?: number;
  contextWindow?: number | null;
  onTextModelChange: (id: string) => void;
  onImageModelChange: (id: string) => void;
  onVideoModelChange: (id: string) => void;
  onExecutionModeChange: (mode: CanvasAgentExecutionMode) => void;
  onDraftChange: (value: string) => void;
  onAttach: () => void;
  onAttachFiles?: (files: File[]) => Promise<void>;
  onRemoveAttachment: (assetId: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onSettings: () => void;
  /** Shared `/` skills and `@` mentions; the owner keeps the textarea ref so it can read the caret. */
  assist?: AgentComposerAssist;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

type ContextEstimateTranslator = (
  key: string,
  values: { used: string; limit?: string },
) => string;

export function formatCanvasAgentContextEstimate(
  translate: ContextEstimateTranslator,
  usedTokens: number,
  contextWindow?: number | null,
): string {
  const used = usedTokens.toLocaleString();
  return contextWindow
    ? translate('canvasAgent.contextEstimate', {
        used,
        limit: contextWindow.toLocaleString(),
      })
    : translate('canvasAgent.contextEstimateUnknownLimit', { used });
}

function ContextRing({ percent }: { percent: number | null }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      {percent !== null ? (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  );
}

export function CanvasAgentComposer({
  textModels,
  imageModels,
  videoModels,
  selectedTextModel,
  requestedTextModel = null,
  modelIssue = null,
  modelSource = 'default',
  externalRuntime,
  selectedImageModelId,
  selectedVideoModelId,
  executionMode,
  draft,
  attachments = [],
  maxAttachments = 8,
  hasMissingAttachments = false,
  isRunning,
  hasPendingApproval,
  hasPendingPlan,
  contextEstimateTokens,
  contextUsage,
  contextDraftTokens,
  contextWindow,
  onTextModelChange,
  onImageModelChange,
  onVideoModelChange,
  onExecutionModeChange,
  onDraftChange,
  onAttach,
  onAttachFiles,
  onRemoveAttachment,
  onSend,
  onCancel,
  onSettings,
  assist,
  textareaRef,
}: Props) {
  const { t } = useTranslation();
  const modelScrollRef = useRef<HTMLDivElement | null>(null);
  const textModelsRef = useRef<HTMLDivElement | null>(null);
  const imageModelsRef = useRef<HTMLDivElement | null>(null);
  const videoModelsRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [openMenu, setOpenMenu] = useState<ComposerMenu>(null);
  const canAttach = attachments.length < maxAttachments;
  const blockedByVision = !externalRuntime && attachments.length > 0 && Boolean(selectedTextModel) && !selectedTextModel?.supportsMultimodal;
  const contextPercent = contextWindow
    ? Math.min(100, Math.round((contextEstimateTokens / contextWindow) * 100))
    : null;
  useEffect(() => { setOpenMenu(null); }, [externalRuntime?.label]);

  const closeMenu = () => {
    setOpenMenu(null);
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  const toggleMenu = (menu: Exclude<ComposerMenu, null>, trigger: HTMLButtonElement) => {
    menuTriggerRef.current = trigger;
    setOpenMenu((current) => current === menu ? null : menu);
  };

  const jumpToModelGroup = (target: HTMLDivElement | null) => {
    if (!target || !modelScrollRef.current) return;
    modelScrollRef.current.scrollTo({ top: target.offsetTop - 54, behavior: 'smooth' });
    requestAnimationFrame(() => target.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }));
  };

  if (!selectedTextModel && !externalRuntime && !textModels.length) {
    return (
      <footer className="agent-composer shrink-0 p-3.5 pt-2">
        {modelIssue && modelIssue !== 'unset' ? (
          <p className="mb-2 flex items-start gap-1.5 px-1 text-[11px] leading-5 text-warning" role="status">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(`rework.agent.selection.issue.${modelIssue}`, { model: requestedTextModel?.modelLabel ?? '' })}
          </p>
        ) : null}
        <UiButton variant="primary" className="min-h-11 w-full gap-2 rounded-[10px] text-sm" onClick={onSettings}>
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          {t('canvasAgent.configureModel')}
        </UiButton>
      </footer>
    );
  }

  const builtinReady = Boolean(externalRuntime ? externalRuntime.ready : selectedTextModel);
  const hint = hasPendingApproval
    ? t('canvasAgent.resolveApprovalHint')
    : hasPendingPlan
      ? t('canvasAgent.resolvePlanHint')
      : blockedByVision
        ? t('canvasAgent.switchToVisionModelHint')
        : externalRuntime && !externalRuntime.ready
          ? t('canvasAgent.runtime.unavailableHint')
          : null;

  const menu = openMenu === 'models' && !externalRuntime ? (
    <AgentComposerPopover title={t('canvasAgent.modelMenuTitle')} onClose={closeMenu}>
      <div className="sticky top-0 z-10 -mx-2.5 -mt-2.5 border-b border-[var(--line)] bg-(--ui-surface-panel) px-2.5 pb-2 pt-2.5">
        <div className="grid grid-cols-3 gap-1 rounded-[8px] bg-[var(--hover)] p-1">
          {[
            { label: t('canvasAgent.modelTabs.text'), icon: <Type className="h-3.5 w-3.5" />, ref: textModelsRef },
            { label: t('canvasAgent.modelTabs.image'), icon: <ImageIcon className="h-3.5 w-3.5" />, ref: imageModelsRef },
            { label: t('canvasAgent.modelTabs.video'), icon: <Video className="h-3.5 w-3.5" />, ref: videoModelsRef },
          ].map((item) => (
            <UiButton
              variant="ghost"
              key={item.label}
              className="min-h-9 gap-1.5 rounded-[6px] px-2 text-[11px]"
              onClick={() => jumpToModelGroup(item.ref.current)}
            >
              {item.icon}
              {item.label}
            </UiButton>
          ))}
        </div>
      </div>
      <div ref={modelScrollRef} className="ui-scrollbar -mx-2.5 max-h-[min(320px,42vh)] overflow-y-auto px-2.5 pt-3">
        <div ref={textModelsRef}>
          <AgentModelOptions
            icon={<Type className="h-3.5 w-3.5" />}
            title={t('canvasAgent.textModels')}
            entries={textModels}
            selectedId={selectedTextModel?.id ?? null}
            onChange={(id) => { onTextModelChange(id); closeMenu(); }}
            emptyLabel={t('canvasAgent.noTextModels')}
          />
        </div>
        <div ref={imageModelsRef}>
          <AgentModelOptions
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t('canvasAgent.imageModels')}
            entries={imageModels}
            selectedId={selectedImageModelId}
            onChange={onImageModelChange}
            emptyLabel={t('canvasAgent.noImageModels')}
          />
        </div>
        <div ref={videoModelsRef}>
          <AgentModelOptions
            icon={<Video className="h-3.5 w-3.5" />}
            title={t('canvasAgent.videoModels')}
            entries={videoModels}
            selectedId={selectedVideoModelId}
            onChange={onVideoModelChange}
            emptyLabel={t('canvasAgent.noVideoModels')}
          />
        </div>
        <UiButton variant="secondary" className="mt-2 min-h-10 w-full gap-2 text-xs" onClick={onSettings}>
          <Settings2 className="h-3.5 w-3.5" />
          {t('canvasAgent.manageModels')}
        </UiButton>
      </div>
    </AgentComposerPopover>
  ) : openMenu === 'mode' && !externalRuntime ? (
    <AgentComposerPopover title={t('canvasAgent.executionMode')} onClose={closeMenu}>
      <AgentModeOptions value={executionMode} onChange={(mode) => { onExecutionModeChange(mode); closeMenu(); }} />
    </AgentComposerPopover>
  ) : openMenu === 'context' && !externalRuntime ? (
    <AgentComposerPopover title={t('canvasAgent.contextUsage')} onClose={closeMenu}>
      <AgentContextDetails usage={contextUsage} contextWindow={contextWindow} draftTokens={contextDraftTokens} modelId={selectedTextModel?.id} />
    </AgentComposerPopover>
  ) : null;

  return (
    <footer className="agent-composer shrink-0 p-3.5 pt-2">
      <AgentComposer
        value={draft}
        placeholder={t('canvasAgent.placeholder')}
        textareaRef={textareaRef}
        assist={assist}
        running={isRunning}
        submitDisabled={!draft.trim() || !builtinReady || hasPendingApproval || hasPendingPlan || blockedByVision || hasMissingAttachments}
        hint={hint}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        onAttachFiles={onAttachFiles}
        menu={menu}
        alerts={<>
          {externalRuntime ? <p className="mb-2 px-1 text-[11px] leading-5 text-text-muted">{t('canvasAgent.runtime.composerHint', { runtime: externalRuntime.label })}</p> : null}
          {hasMissingAttachments ? (
            <p className="agent-note mb-2" data-tone="danger" role="alert">
              <CircleAlert className="mt-[3px] shrink-0" aria-hidden="true" />
              <span>{t('canvasAgent.missingAttachmentBeforeSend')}</span>
            </p>
          ) : null}
        </>}
        tools={<>
          <AgentComposerTool
            label={canAttach ? t('canvasAgent.addAttachment') : t('canvasAgent.attachmentLimit', { max: maxAttachments })}
            disabled={!canAttach}
            onClick={() => { setOpenMenu(null); onAttach(); }}
          >
            <Plus />
          </AgentComposerTool>
          {!externalRuntime ? (
            <AgentModelPill
              model={selectedTextModel}
              requestedModel={requestedTextModel}
              issue={modelIssue}
              source={modelSource}
              open={openMenu === 'models'}
              onClick={(event) => toggleMenu('models', event.currentTarget)}
            />
          ) : null}
          {assist ? (
            <AgentComposerTool label={t('rework.skills.pickerTitle')} expanded={assist.skillsOpen} onClick={() => { setOpenMenu(null); assist.toggleSkills(); }}>
              <BookOpen />
            </AgentComposerTool>
          ) : null}
          {!externalRuntime ? (
            <>
              <AgentComposerTool label={t('canvasAgent.executionMode')} expanded={openMenu === 'mode'} onClick={(event) => toggleMenu('mode', event.currentTarget)}>
                <Gauge />
                <span className="agent-pill__label hidden sm:block">{t(`canvasAgent.executionModes.${executionMode}.short`)}</span>
              </AgentComposerTool>
              <button
                type="button"
                className="agent-ring"
                aria-label={t('canvasAgent.contextUsage')}
                title={formatCanvasAgentContextEstimate(t, contextEstimateTokens, contextWindow)}
                aria-expanded={openMenu === 'context'}
                onClick={(event) => toggleMenu('context', event.currentTarget)}
              >
                <ContextRing percent={contextPercent} />
                {contextUsage?.modelId === selectedTextModel?.id ? <span className="text-[11px] tabular-nums">{formatAgentContextPercent(contextEstimateTokens, contextWindow)}</span> : null}
              </button>
            </>
          ) : null}
        </>}
        status={blockedByVision ? <span className="mr-1 text-[10px] text-warning">{t('canvasAgent.switchToVisionModel')}</span> : null}
        onChange={onDraftChange}
        onSubmit={onSend}
        onStop={onCancel}
      />
    </footer>
  );
}
