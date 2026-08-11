import { useEffect, useRef } from 'react';
import { CircleAlert, CircleStop, ImagePlus, Send, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { AgentTurnMediaInput } from '../domain/agentModel';

interface ModelEntry {
  id: string;
  providerLabel: string;
  modelLabel: string;
  supportsMultimodal: boolean;
}

interface Props {
  entries: ModelEntry[];
  selectedEntry: ModelEntry | null;
  draft: string;
  attachments: AgentTurnMediaInput[];
  maxAttachments: number;
  hasMissingAttachments: boolean;
  isRunning: boolean;
  hasPendingApproval: boolean;
  hasPendingPlan: boolean;
  onModelChange: (id: string) => void;
  onDraftChange: (value: string) => void;
  onAttach: () => void;
  onRemoveAttachment: (assetId: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onSettings: () => void;
}

export function CanvasAgentComposer({
  entries,
  selectedEntry,
  draft,
  attachments = [],
  maxAttachments = 8,
  hasMissingAttachments = false,
  isRunning,
  hasPendingApproval,
  hasPendingPlan,
  onModelChange,
  onDraftChange,
  onAttach,
  onRemoveAttachment,
  onSend,
  onCancel,
  onSettings,
}: Props) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canAttach = Boolean(
    selectedEntry?.supportsMultimodal
    && attachments.length < maxAttachments,
  );
  const blockedByVision = attachments.length > 0 && !selectedEntry?.supportsMultimodal;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '44px';
    textarea.style.height = `${Math.min(128, Math.max(44, textarea.scrollHeight))}px`;
  }, [draft]);

  if (!selectedEntry) {
    return (
      <footer className="agent-composer shrink-0 border-t border-border-dark p-3">
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[5px] bg-accent px-3 text-sm font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/[0.85] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          onClick={onSettings}
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          {t('canvasAgent.configureModel')}
        </button>
      </footer>
    );
  }

  return (
    <footer className="agent-composer shrink-0 border-t border-border-dark p-3">
      <div className="mb-2 flex items-center gap-2">
        <select
          aria-label={t('canvasAgent.modelSelect')}
          className="h-11 min-w-0 flex-1 rounded-[5px] border border-border-dark bg-bg-dark px-2 text-[11px] text-text-dark outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-2 focus:ring-accent/[0.12] sm:h-10"
          value={selectedEntry.id}
          onChange={(event) => onModelChange(event.target.value)}
        >
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.providerLabel} / {entry.modelLabel}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] border border-border-dark text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title={t('canvasAgent.modelSettings')}
          aria-label={t('canvasAgent.modelSettings')}
          onClick={onSettings}
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {attachments.length ? (
        <div className="agent-feed-enter mb-2 space-y-1.5" aria-label={t('canvasAgent.attachments')}>
          <div className="flex items-center justify-between px-0.5 text-[10px] text-text-muted">
            <span>{t('canvasAgent.attachmentCount', { count: attachments.length, max: maxAttachments })}</span>
            {blockedByVision ? (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-200">
                <CircleAlert className="h-3 w-3" aria-hidden="true" />
                {t('canvasAgent.switchToVisionModel')}
              </span>
            ) : null}
          </div>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {attachments.map((attachment) => (
              <div
                key={attachment.assetId}
                className="flex min-h-10 max-w-full items-center gap-1.5 rounded-[5px] border border-accent/25 bg-accent/[0.08] p-1 pr-0.5 text-[11px] text-text-dark"
                title={attachment.title}
              >
                <img
                  src={resolveImageDisplayUrl(attachment.source)}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-[3px] bg-black/10 object-cover"
                  draggable={false}
                />
                <span className="max-w-36 truncate">{attachment.title}</span>
                <button
                  type="button"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  aria-label={t('canvasAgent.removeNamedAttachment', { name: attachment.title })}
                  title={t('canvasAgent.removeNamedAttachment', { name: attachment.title })}
                  onClick={() => onRemoveAttachment(attachment.assetId)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {hasMissingAttachments ? (
        <div className="mb-2 flex items-start gap-1.5 rounded-[5px] border border-red-500/30 bg-red-500/[0.07] px-2 py-1.5 text-[11px] leading-5 text-red-700 dark:text-red-200" role="alert">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('canvasAgent.missingAttachmentBeforeSend')}</span>
        </div>
      ) : null}

      <div className="flex items-end gap-1 rounded-[6px] border border-border-dark bg-bg-dark/[0.55] p-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-accent/[0.55] focus-within:shadow-[0_0_0_2px_rgb(var(--accent-rgb)/0.09)]">
        <button
          type="button"
          disabled={!canAttach}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-[0.35] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title={selectedEntry.supportsMultimodal
            ? attachments.length >= maxAttachments
              ? t('canvasAgent.attachmentLimit', { max: maxAttachments })
              : t('canvasAgent.addAttachment')
            : t('canvasAgent.visionRequired')}
          aria-label={selectedEntry.supportsMultimodal
            ? t('canvasAgent.addAttachment')
            : t('canvasAgent.visionRequired')}
          onClick={onAttach}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          aria-label={t('canvasAgent.placeholder')}
          className="max-h-32 min-h-11 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2.5 text-sm leading-5 text-text-dark outline-none placeholder:text-text-muted"
          value={draft}
          rows={1}
          placeholder={t('canvasAgent.placeholder')}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        {isRunning ? (
          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-red-600 transition-[background-color,transform] duration-150 hover:bg-red-500/[0.08] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 dark:text-red-300"
            title={t('canvasAgent.cancel')}
            aria-label={t('canvasAgent.cancel')}
            onClick={onCancel}
          >
            <CircleStop className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!draft.trim() || hasPendingApproval || hasPendingPlan || blockedByVision || hasMissingAttachments}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] bg-accent text-white transition-[background-color,transform] duration-150 hover:bg-accent/[0.85] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-[0.35] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            title={t('canvasAgent.send')}
            aria-label={t('canvasAgent.send')}
            onClick={onSend}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mt-1.5 px-1 text-[10px] text-text-muted">
        {blockedByVision
          ? t('canvasAgent.switchToVisionModelHint')
          : hasMissingAttachments
            ? t('canvasAgent.missingAttachmentBeforeSend')
            : hasPendingPlan
          ? t('canvasAgent.resolvePlanHint')
          : hasPendingApproval
            ? t('canvasAgent.resolveApprovalHint')
            : t('canvasAgent.enterHint')}
      </div>
    </footer>
  );
}
