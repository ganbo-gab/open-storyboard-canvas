import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { loadImage, readSystemClipboard } from '@/commands/image';
import { ArrowUp, Boxes, Check, CircleAlert, Sparkles, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiTextArea } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import type { CanvasAgentExecutionMode } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import type { AgentTurnMediaInput } from '@/features/canvas/agent/domain/agentModel';
import type { AgentComposerAssist } from './useAgentComposerAssist';
import type { AgentModelIssue, AgentSelectionSource } from './useAgentTurnSelection';

export interface AgentModelOption {
  id: string;
  providerLabel: string;
  modelLabel: string;
  usable?: boolean;
}

/** Enter sends; Shift+Enter and the Enter that commits an IME composition never do. */
export function shouldSubmitAgentComposerEnter(input: {
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

export function AgentComposerTool({
  label,
  expanded,
  disabled = false,
  tone,
  onClick,
  children,
}: {
  label: string;
  /** Set only for controls that open a menu or picker. */
  expanded?: boolean;
  disabled?: boolean;
  tone?: 'warning';
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="agent-pill"
      data-open={expanded || undefined}
      data-tone={tone}
      disabled={disabled}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The actual model and channel the next turn uses, or why there is none. */
export function AgentModelPill({
  model,
  requestedModel,
  issue,
  source,
  open,
  disabled,
  onClick,
}: {
  model: AgentModelOption | null;
  requestedModel: AgentModelOption | null;
  issue: AgentModelIssue | null;
  source: AgentSelectionSource;
  open: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const label = model
    ? `${model.providerLabel} · ${model.modelLabel}`
    : t(`rework.agent.selection.issue.${issue ?? 'unset'}`, { model: requestedModel?.modelLabel ?? '' });
  const title = model
    ? `${t('canvasAgent.modelMenuTitle')}: ${label} (${t(`rework.agent.selection.source.${source}`)})`
    : label;
  return (
    <button
      type="button"
      className="agent-pill"
      data-open={open || undefined}
      data-tone={model ? undefined : 'warning'}
      disabled={disabled}
      aria-label={title}
      aria-expanded={open}
      title={title}
      onClick={onClick}
    >
      {model ? <Boxes aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span className="agent-pill__label max-w-44">{label}</span>
    </button>
  );
}

export function AgentComposerPopover({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    popoverRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus();
  }, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || popoverRef.current?.contains(target) || target.closest('.agent-pill, .ui-menu')) return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [onClose]);
  return (
    <section
      ref={popoverRef}
      className="agent-view-enter absolute inset-x-0 bottom-[calc(100%+10px)] z-40 max-h-[min(420px,58vh)] overflow-hidden rounded-[12px] border border-(--ui-border-soft) bg-(--ui-surface-panel) shadow-(--ui-shadow-panel)"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex h-11 items-center justify-between border-b border-[var(--line)] px-3.5">
        <h3 className="text-xs font-semibold text-text-dark">{title}</h3>
        <UiIconButton onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          <X className="h-3.5 w-3.5" />
        </UiIconButton>
      </header>
      <div className="ui-scrollbar max-h-[min(374px,50vh)] overflow-y-auto p-2.5">{children}</div>
    </section>
  );
}

export function AgentModelOptions({
  icon,
  title,
  entries,
  selectedId,
  onChange,
  emptyLabel,
}: {
  icon: ReactNode;
  title: string;
  entries: readonly AgentModelOption[];
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
        <div className="space-y-1" role="listbox" aria-label={title}>
          {entries.map((entry) => {
            const selected = entry.id === selectedId;
            return (
              <UiButton
                variant="ghost"
                key={entry.id}
                role="option"
                aria-selected={selected}
                disabled={entry.usable === false}
                className={`h-auto min-h-11 w-full gap-3 rounded-[8px] px-2.5 text-left ${selected ? 'bg-accent/11 text-text-dark' : 'text-text-dark'}`}
                onClick={() => onChange(entry.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{entry.modelLabel}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-muted">{entry.providerLabel}</span>
                </span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
              </UiButton>
            );
          })}
        </div>
      ) : (
        <div className="rounded-[8px] border border-dashed border-[var(--line)] px-3 py-4 text-center text-[11px] text-text-muted">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

export function AgentModeOptions({ value, onChange }: { value: CanvasAgentExecutionMode; onChange: (mode: CanvasAgentExecutionMode) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('canvasAgent.executionMode')}>
      {(['manual', 'auto', 'full'] as const).map((mode) => (
        <UiButton
          variant="ghost"
          key={mode}
          role="radio"
          aria-checked={value === mode}
          className={`mb-1 h-auto min-h-14 w-full items-start gap-3 rounded-[8px] px-3 py-2.5 text-left last:mb-0 ${value === mode ? 'bg-accent/11' : ''}`}
          onClick={() => onChange(mode)}
        >
          {mode === 'manual'
            ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            : <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-text-dark">{t(`canvasAgent.executionModes.${mode}.title`)}</span>
            <span className="mt-1 block whitespace-normal text-[11px] leading-4 text-text-muted">{t(`canvasAgent.executionModes.${mode}.description`)}</span>
          </span>
          {value === mode ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : null}
        </UiButton>
      ))}
    </div>
  );
}

/**
 * Shared Agent composer chrome for Canvas, home and stage. Owners keep send authority: this shell
 * only reports submit/stop intents and never sends while a guard (`submitDisabled`) holds.
 */
export function AgentComposer({
  value,
  placeholder,
  textareaRef,
  assist,
  running,
  submitDisabled,
  hint,
  attachments = [],
  onRemoveAttachment,
  menu,
  alerts,
  tools,
  status,
  onChange,
  onSubmit,
  onStop,
  onAttachFiles,
  onAttachmentBusyChange,
}: {
  value: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  assist?: AgentComposerAssist;
  /** Shows the stop control instead of send. */
  running: boolean;
  submitDisabled: boolean;
  /** Why sending is blocked or what happens next; shown under the composer. */
  hint?: string | null;
  attachments?: readonly AgentTurnMediaInput[];
  onRemoveAttachment?: (assetId: string) => void;
  /** Owner popovers (model, mode, context) anchored above the composer. */
  menu?: ReactNode;
  alerts?: ReactNode;
  tools: ReactNode;
  status?: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onAttachFiles?: (files: File[]) => Promise<void>;
  onAttachmentBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const compositionActiveRef = useRef(false);
  // No composition has ended yet; the first Enter right after load must still send.
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [attachmentError, setAttachmentError] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const attachmentRequest = useRef({ epoch: 0, busy: false, mounted: true });
  useEffect(() => {
    attachmentRequest.current.mounted = true;
    return () => { attachmentRequest.current.mounted = false; attachmentRequest.current.epoch += 1; };
  }, []);
  const attach = async (input: File[] | (() => Promise<File[]>)) => {
    const owner = attachmentRequest.current;
    if (!onAttachFiles || running || owner.busy || !owner.mounted) return;
    const epoch = ++owner.epoch;
    owner.busy = true;
    setAttaching(true); setAttachmentError(''); onAttachmentBusyChange?.(true);
    const current = () => owner.mounted && owner.epoch === epoch;
    try {
      const files = typeof input === 'function' ? await input() : input;
      if (current() && files.length) await onAttachFiles(files);
    } catch (cause) {
      if (current()) setAttachmentError(cause instanceof Error ? cause.message : '图片添加失败，请重试。');
    } finally {
      if (current()) { owner.busy = false; setAttaching(false); onAttachmentBusyChange?.(false); }
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '44px';
    textarea.style.height = `${Math.min(168, Math.max(44, textarea.scrollHeight))}px`;
  }, [textareaRef, value]);

  return (
    <div className="relative">
      {assist?.popover}
      {menu}
      {alerts}
      <div className="studio-composer agent-input-shell" data-dragging={dragging || undefined}
        onDragOver={(event) => { if (onAttachFiles && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { if (!onAttachFiles) return; event.preventDefault(); event.stopPropagation(); setDragging(false); void attach(Array.from(event.dataTransfer.files)); }}>
        {assist?.chips}
        {attachments.length ? (
          <ul className="agent-attachment-tray" aria-label={t('canvasAgent.attachments')}>
            {attachments.map((attachment) => (
              <li key={attachment.assetId} className="agent-attachment-tile" title={attachment.title}>
                <AssetMedia kind="image" source={attachment.source} alt={attachment.title} className="h-16 w-20 rounded-lg bg-(--canvas-node-media-bg) object-cover" draggable={false} />
                <span className="block w-20 truncate px-1 pt-1 text-[10px] text-text-muted">{attachment.title}</span>
                {onRemoveAttachment ? (
                  <UiIconButton
                    aria-label={t('canvasAgent.removeNamedAttachment', { name: attachment.title })}
                    title={t('canvasAgent.removeNamedAttachment', { name: attachment.title })}
                    onClick={() => onRemoveAttachment(attachment.assetId)}
                    className="agent-attachment-remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </UiIconButton>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <UiTextArea
          ref={textareaRef}
          aria-label={placeholder}
          className="max-h-[168px] min-h-11 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-6 shadow-none focus:ring-0"
          value={value}
          rows={1}
          placeholder={placeholder}
          onChange={(event) => { onChange(event.target.value); if (assist) requestAnimationFrame(assist.sync); }}
          onClick={assist?.sync}
          onPaste={(event) => {
            if (!onAttachFiles) return;
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (!files.length) for (const item of Array.from(event.clipboardData.items ?? [])) {
              if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
              const file = item.getAsFile(); if (file) files.push(file);
            }
            if (files.length) { event.preventDefault(); event.stopPropagation(); void attach(files); return; }
            const text = event.clipboardData.getData('text/plain');
            if (!isTauri() || (text && !/^(?:file:\/\/|\/|[A-Za-z]:\\).+\.(?:png|jpe?g|webp|gif|bmp|heic|tiff?)\s*$/i.test(text.trim()))) return;
            event.preventDefault(); event.stopPropagation();
            void attach(async () => {
              if (text.trim()) {
                // Only the local image path explicitly pasted by this user gesture is read.
                const path = text.trim();
                const source = await loadImage(path);
                const blob = await (await fetch(source)).blob();
                return [new File([blob], path.split(/[\\/]/).at(-1) || 'pasted-image.png', { type: blob.type })];
              }
              // Native fallback only when this paste event carries neither image bytes nor text.
              const clipboard = await readSystemClipboard();
              if (!clipboard?.image) return [];
              const image = clipboard.image;
              return [new File([new Uint8Array(image.bytes)], image.fileName || 'pasted-image.png', { type: image.mimeType || 'image/png' })];
            });
          }}
          onCompositionStart={() => { compositionActiveRef.current = true; }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onKeyDown={(event) => {
            if (assist?.onKeyDown(event)) return;
            if (shouldSubmitAgentComposerEnter({
              key: event.key,
              shiftKey: event.shiftKey,
              nativeIsComposing: event.nativeEvent.isComposing,
              trackedIsComposing: compositionActiveRef.current,
              compositionEndedAgoMs: performance.now() - compositionEndedAtRef.current,
            })) {
              event.preventDefault();
              if (!running && !submitDisabled && !attachmentRequest.current.busy) onSubmit();
            }
          }}
        />
        <div className="agent-input-footer">
          <div className="agent-input-tools">{tools}</div>
          {status && <span className="agent-input-status">{status}</span>}
          {running ? (
            <button type="button" className="studio-send h-9 w-9" aria-label={t('canvasAgent.cancel')} title={t('canvasAgent.cancel')} onClick={onStop}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="studio-send h-9 w-9" aria-label={t('canvasAgent.send')} title={t('canvasAgent.send')} disabled={submitDisabled || attaching} onClick={() => { if (!attachmentRequest.current.busy) onSubmit(); }}>
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {attaching && <p role="status" className="px-2 pt-1 text-xs text-text-muted">正在添加图片…</p>}
      {attachmentError && <p role="alert" className="px-2 pt-1 text-xs text-danger">{attachmentError}</p>}
      {hint ? <p className="mt-1.5 px-2 text-[11px] leading-4 text-text-subtle" role="status">{hint}</p> : null}
      {assist?.dialogs}
    </div>
  );
}
