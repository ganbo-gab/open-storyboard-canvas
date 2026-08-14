import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  Boxes,
  Check,
  CircleAlert,
  CircleDot,
  CircleStop,
  Gauge,
  ImageIcon,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Type,
  Video,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { AgentTurnMediaInput } from '../domain/agentModel';
import type { AgentExecutionMode } from './agentPanelStore';

interface ModelEntry {
  id: string;
  providerLabel: string;
  modelLabel: string;
  supportsMultimodal?: boolean;
  usable?: boolean;
}

type ComposerMenu = 'models' | 'mode' | 'context' | null;

interface Props {
  textModels: ModelEntry[];
  imageModels: ModelEntry[];
  videoModels: ModelEntry[];
  selectedTextModel: ModelEntry | null;
  selectedImageModelId: string | null;
  selectedVideoModelId: string | null;
  executionMode: AgentExecutionMode;
  draft: string;
  attachments?: AgentTurnMediaInput[];
  maxAttachments?: number;
  hasMissingAttachments?: boolean;
  isRunning: boolean;
  hasPendingApproval: boolean;
  hasPendingPlan: boolean;
  contextEstimateTokens: number;
  contextWindow?: number | null;
  onTextModelChange: (id: string) => void;
  onImageModelChange: (id: string) => void;
  onVideoModelChange: (id: string) => void;
  onExecutionModeChange: (mode: AgentExecutionMode) => void;
  onDraftChange: (value: string) => void;
  onAttach: () => void;
  onRemoveAttachment: (assetId: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onSettings: () => void;
}

type ContextEstimateTranslator = (
  key: string,
  values: { used: string; limit?: string },
) => string;

export function shouldSubmitCanvasAgentComposerEnter(input: {
  key: string;
  shiftKey: boolean;
  nativeIsComposing: boolean;
  trackedIsComposing: boolean;
  compositionEndedAgoMs: number;
}): boolean {
  return input.key === 'Enter'
    && !input.shiftKey
    && !input.nativeIsComposing
    && !input.trackedIsComposing
    && input.compositionEndedAgoMs >= 80;
}

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

function ToolButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex h-10 min-w-10 items-center justify-center rounded-[7px] px-2 transition-[background-color,color,transform] duration-150 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${active
        ? 'bg-accent/[0.12] text-accent'
        : 'text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark'}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ComposerPopover({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const popoverRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    popoverRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus();
  }, []);

  return (
    <section
      ref={popoverRef}
      className="agent-view-enter absolute inset-x-0 bottom-[calc(100%+10px)] z-40 max-h-[min(420px,58vh)] overflow-hidden rounded-[10px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] shadow-[var(--ui-shadow-panel)]"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex h-11 items-center justify-between border-b border-border-dark/70 px-3.5">
        <h3 className="text-xs font-semibold text-text-dark">{title}</h3>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark"
          onClick={onClose}
          aria-label={title}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="ui-scrollbar max-h-[min(374px,50vh)] overflow-y-auto p-2.5">{children}</div>
    </section>
  );
}

function ModelGroup({
  icon,
  title,
  entries,
  selectedId,
  onChange,
  emptyLabel,
}: {
  icon: ReactNode;
  title: string;
  entries: ModelEntry[];
  selectedId: string | null;
  onChange: (id: string) => void;
  emptyLabel: string;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-center gap-2 px-1 text-[10px] font-medium text-text-muted">
        {icon}
        <span>{title}</span>
      </div>
      {entries.length ? (
        <div className="space-y-1">
          {entries.map((entry) => {
            const selected = entry.id === selectedId;
            return (
              <button
                key={entry.id}
                type="button"
                disabled={entry.usable === false}
                className={`flex min-h-11 w-full items-center gap-3 rounded-[7px] px-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${selected
                  ? 'bg-accent/[0.11] text-text-dark'
                  : 'text-text-dark hover:bg-text-dark/[0.045]'}`}
                onClick={() => onChange(entry.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{entry.modelLabel}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-muted">{entry.providerLabel}</span>
                </span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-[7px] border border-dashed border-border-dark/75 px-3 py-4 text-center text-[11px] text-text-muted">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

export function CanvasAgentComposer({
  textModels,
  imageModels,
  videoModels,
  selectedTextModel,
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
  contextWindow,
  onTextModelChange,
  onImageModelChange,
  onVideoModelChange,
  onExecutionModeChange,
  onDraftChange,
  onAttach,
  onRemoveAttachment,
  onSend,
  onCancel,
  onSettings,
}: Props) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelScrollRef = useRef<HTMLDivElement | null>(null);
  const textModelsRef = useRef<HTMLDivElement | null>(null);
  const imageModelsRef = useRef<HTMLDivElement | null>(null);
  const videoModelsRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compositionActiveRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const [openMenu, setOpenMenu] = useState<ComposerMenu>(null);
  const canAttach = attachments.length < maxAttachments;
  const blockedByVision = attachments.length > 0 && !selectedTextModel?.supportsMultimodal;
  const contextPercent = contextWindow
    ? Math.min(100, Math.round((contextEstimateTokens / contextWindow) * 100))
    : null;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '48px';
    textarea.style.height = `${Math.min(156, Math.max(48, textarea.scrollHeight))}px`;
  }, [draft]);

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
    const top = target.offsetTop - 54;
    modelScrollRef.current.scrollTo({ top, behavior: 'smooth' });
    requestAnimationFrame(() => target.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }));
  };

  if (!selectedTextModel) {
    return (
      <footer className="agent-composer shrink-0 p-3.5 pt-2">
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-accent px-3 text-sm font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/[0.85] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          onClick={onSettings}
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          {t('canvasAgent.configureModel')}
        </button>
      </footer>
    );
  }

  return (
    <footer className="agent-composer shrink-0 p-3.5 pt-2">
      <div className="relative">
        {openMenu === 'models' ? (
          <ComposerPopover title={t('canvasAgent.modelMenuTitle')} onClose={closeMenu}>
            <div className="sticky top-0 z-10 -mx-2.5 -mt-2.5 border-b border-border-dark/60 bg-[var(--ui-surface-panel)] px-2.5 pb-2 pt-2.5">
              <div className="grid grid-cols-3 gap-1 rounded-[8px] bg-text-dark/[0.045] p-1">
                {[
                  { label: t('canvasAgent.modelTabs.text'), icon: <Type className="h-3.5 w-3.5" />, ref: textModelsRef },
                  { label: t('canvasAgent.modelTabs.image'), icon: <ImageIcon className="h-3.5 w-3.5" />, ref: imageModelsRef },
                  { label: t('canvasAgent.modelTabs.video'), icon: <Video className="h-3.5 w-3.5" />, ref: videoModelsRef },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-[var(--ui-surface-field)] hover:text-text-dark active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    onClick={() => jumpToModelGroup(item.ref.current)}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div ref={modelScrollRef} className="ui-scrollbar -mx-2.5 max-h-[min(320px,42vh)] overflow-y-auto px-2.5 pt-3">
              <div ref={textModelsRef}>
                <ModelGroup
                  icon={<Type className="h-3.5 w-3.5" />}
                  title={t('canvasAgent.textModels')}
                  entries={textModels}
                  selectedId={selectedTextModel.id}
                  onChange={(id) => { onTextModelChange(id); closeMenu(); }}
                  emptyLabel={t('canvasAgent.noTextModels')}
                />
              </div>
              <div ref={imageModelsRef}>
                <ModelGroup
                  icon={<ImageIcon className="h-3.5 w-3.5" />}
                  title={t('canvasAgent.imageModels')}
                  entries={imageModels}
                  selectedId={selectedImageModelId}
                  onChange={onImageModelChange}
                  emptyLabel={t('canvasAgent.noImageModels')}
                />
              </div>
              <div ref={videoModelsRef}>
                <ModelGroup
                  icon={<Video className="h-3.5 w-3.5" />}
                  title={t('canvasAgent.videoModels')}
                  entries={videoModels}
                  selectedId={selectedVideoModelId}
                  onChange={onVideoModelChange}
                  emptyLabel={t('canvasAgent.noVideoModels')}
                />
              </div>
              <button type="button" className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-[7px] border border-border-dark text-xs text-text-muted hover:bg-text-dark/[0.045] hover:text-text-dark" onClick={onSettings}>
                <Settings2 className="h-3.5 w-3.5" />
                {t('canvasAgent.manageModels')}
              </button>
            </div>
          </ComposerPopover>
        ) : null}

        {openMenu === 'mode' ? (
          <ComposerPopover title={t('canvasAgent.executionMode')} onClose={closeMenu}>
            {(['manual', 'auto'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`mb-1 flex min-h-14 w-full items-start gap-3 rounded-[8px] px-3 py-2.5 text-left last:mb-0 ${executionMode === mode ? 'bg-accent/[0.11]' : 'hover:bg-text-dark/[0.045]'}`}
                onClick={() => { onExecutionModeChange(mode); closeMenu(); }}
              >
                {mode === 'manual' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-text-dark">{t(`canvasAgent.executionModes.${mode}.title`)}</span>
                  <span className="mt-1 block text-[11px] leading-4 text-text-muted">{t(`canvasAgent.executionModes.${mode}.description`)}</span>
                </span>
                {executionMode === mode ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : null}
              </button>
            ))}
          </ComposerPopover>
        ) : null}

        {openMenu === 'context' ? (
          <ComposerPopover title={t('canvasAgent.contextUsage')} onClose={closeMenu}>
            <div className="rounded-[8px] bg-text-dark/[0.035] p-3">
              <div className="text-xs font-semibold text-text-dark">
                {formatCanvasAgentContextEstimate(t, contextEstimateTokens, contextWindow)}
              </div>
              {contextPercent !== null ? (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-text-dark/[0.08]">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${contextPercent}%` }} />
                </div>
              ) : null}
              <p className="mt-3 text-[11px] leading-5 text-text-muted">
                {t('canvasAgent.contextIncludes', { messages: t('canvasAgent.conversation'), attachments: attachments.length })}
              </p>
              <p className="mt-2 text-[10px] leading-4 text-text-muted/80">{t('canvasAgent.contextEstimateNotice')}</p>
            </div>
          </ComposerPopover>
        ) : null}

        {attachments.length ? (
          <div className="agent-feed-enter mb-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto" aria-label={t('canvasAgent.attachments')}>
            {attachments.map((attachment) => (
              <div key={attachment.assetId} className="flex min-h-10 max-w-full items-center gap-1.5 rounded-[7px] border border-accent/20 bg-accent/[0.07] p-1 pr-0.5 text-[11px] text-text-dark" title={attachment.title}>
                <img src={resolveImageDisplayUrl(attachment.source)} alt="" className="h-8 w-8 shrink-0 rounded-[5px] bg-black/10 object-cover" draggable={false} />
                <span className="max-w-36 truncate">{attachment.title}</span>
                <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark" aria-label={t('canvasAgent.removeNamedAttachment', { name: attachment.title })} onClick={() => onRemoveAttachment(attachment.assetId)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {hasMissingAttachments ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-[7px] border border-red-500/25 bg-red-500/[0.07] px-2.5 py-2 text-[11px] leading-5 text-red-700 dark:text-red-200" role="alert">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('canvasAgent.missingAttachmentBeforeSend')}</span>
          </div>
        ) : null}

        <div className="rounded-[14px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-2 shadow-[0_10px_28px_rgba(0,0,0,0.09)] transition-[border-color,box-shadow] duration-150 focus-within:border-accent/45 focus-within:shadow-[0_10px_30px_rgba(0,0,0,0.12),0_0_0_2px_rgba(var(--accent-rgb),0.08)]">
          <textarea
            ref={textareaRef}
            aria-label={t('canvasAgent.placeholder')}
            className="max-h-[156px] min-h-12 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-5 text-text-dark outline-none placeholder:text-text-muted/65"
            value={draft}
            rows={1}
            placeholder={t('canvasAgent.placeholder')}
            onChange={(event) => onDraftChange(event.target.value)}
            onCompositionStart={() => {
              compositionActiveRef.current = true;
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
              compositionEndedAtRef.current = performance.now();
            }}
            onKeyDown={(event) => {
              if (shouldSubmitCanvasAgentComposerEnter({
                key: event.key,
                shiftKey: event.shiftKey,
                nativeIsComposing: event.nativeEvent.isComposing,
                trackedIsComposing: compositionActiveRef.current,
                compositionEndedAgoMs: performance.now() - compositionEndedAtRef.current,
              })) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <div className="mt-1 flex items-center gap-0.5">
            <ToolButton label={canAttach ? t('canvasAgent.addAttachment') : t('canvasAgent.attachmentLimit', { max: maxAttachments })} disabled={!canAttach} onClick={() => { setOpenMenu(null); onAttach(); }}>
              <Plus className="h-[19px] w-[19px]" />
            </ToolButton>
            <ToolButton label={t('canvasAgent.modelMenuTitle')} active={openMenu === 'models'} onClick={(event) => toggleMenu('models', event.currentTarget)}>
              <Boxes className="h-[18px] w-[18px]" />
            </ToolButton>
            <ToolButton label={t('canvasAgent.executionMode')} active={openMenu === 'mode'} onClick={(event) => toggleMenu('mode', event.currentTarget)}>
              <Gauge className="h-[18px] w-[18px]" />
              <span className="ml-1 hidden max-w-16 truncate text-[10px] sm:block">{t(`canvasAgent.executionModes.${executionMode}.short`)}</span>
            </ToolButton>
            <ToolButton label={t('canvasAgent.contextUsage')} active={openMenu === 'context'} onClick={(event) => toggleMenu('context', event.currentTarget)}>
              <CircleDot className="h-[18px] w-[18px]" />
            </ToolButton>

            <span className="flex-1" />
            {blockedByVision ? <span className="mr-1 text-[10px] text-amber-700 dark:text-amber-200">{t('canvasAgent.switchToVisionModel')}</span> : null}
            {isRunning ? (
              <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-red-500/[0.10] text-red-600 transition-transform active:scale-[0.96] dark:text-red-300" aria-label={t('canvasAgent.cancel')} onClick={onCancel}>
                <CircleStop className="h-[19px] w-[19px]" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!draft.trim() || hasPendingApproval || hasPendingPlan || blockedByVision || hasMissingAttachments}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-text-dark text-bg-dark transition-[opacity,transform] duration-150 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-25"
                aria-label={t('canvasAgent.send')}
                onClick={onSend}
              >
                <Send className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
