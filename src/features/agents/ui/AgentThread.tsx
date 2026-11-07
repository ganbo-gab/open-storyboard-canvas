import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { UiModal } from '@/components/ui';
import { useState, type ReactNode } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Copy,
  ImageOff,
  LoaderCircle,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { AgentSessionMediaReferenceView } from '@/features/canvas/agent/domain/agentModel';
import { AgentFailureNotice } from './AgentFailureNotice';

/** Models often pack lists and headings into one line; split them without touching code or URLs. */
export function normalizeCompactAgentMarkdown(value: string): string {
  const segments = value.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+)/g);
  return segments.map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment
      .replace(/\*\*([^*\n]+)\*\*(?=[^\s：:，,。.!！?？;；])/g, '**$1**\n')
      .replace(/([^\n])\s+-\s+(?=[^\n])/g, '$1\n- ')
      .replace(/([^\n])---(?=\S)/g, '$1\n\n---\n')
      .replace(/：(?=(?:-|\d+\.|[A-Za-z][^\n]{0,20}:))/g, '：\n')
      .replace(/\s+-\s+(?=(?:节点|文件|比例|分辨率|状态|生成|资产|原始|解决|结果|Node|File|Ratio|Resolution|Status))/gi, '\n- ');
  }).join('');
}

/** Localized action title for a registered Agent tool; unknown tools keep their stable name. */
export function agentToolTitle(t: TFunction, toolName: string): string {
  return t(`rework.agent.actions.${toolName}`, { defaultValue: toolName });
}

function AgentAttachmentList({ attachments }: { attachments: readonly AgentSessionMediaReferenceView[] }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<AgentSessionMediaReferenceView | null>(null);
  return (
    <>
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t('canvasAgent.attachments')}>
      {attachments.map((attachment) => {
        const missing = attachment.availability === 'missing';
        return (
          <li
            key={attachment.referenceId}
            className={`inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
              missing ? 'bg-danger/8 text-danger' : 'bg-[var(--hover)] text-text-muted'
            }`}
            title={missing ? t('canvasAgent.missingAttachmentNamed', { name: attachment.title }) : attachment.title}
          >
            {attachment.previewSource && !missing ? <button type="button" className="block text-left" aria-label={`查看图片 ${attachment.title}`} onClick={() => setPreview(attachment)}>
              <AssetMedia kind="image" source={attachment.previewSource} alt={attachment.title} className="h-24 w-32 rounded-lg object-cover" />
              <span className="mt-1 block w-32 truncate">{attachment.title}</span>
            </button> : <><ImageOff className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{attachment.title}</span></>}
            {missing ? <span className="shrink-0">{t('canvasAgent.missingReference')}</span> : null}
          </li>
        );
      })}
    </ul>
    <UiModal isOpen={preview !== null} title={preview?.title ?? ''} onClose={() => setPreview(null)} widthClassName="w-[min(900px,90vw)]">
      {preview?.previewSource && <AssetMedia kind="image" source={preview.previewSource} alt={preview.title} className="max-h-[70vh] w-full object-contain" />}
    </UiModal>
    </>
  );
}

/** User turns are soft bubbles, assistant turns are plain prose (agent.css). */
export function AgentMessage({
  role,
  text,
  attachments,
  streaming = false,
}: {
  role: 'user' | 'assistant';
  text: string;
  attachments?: readonly AgentSessionMediaReferenceView[];
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopyState('copied'); }
    catch { setCopyState('error'); }
  };
  if (role === 'user') {
    return (
      <div className="agent-feed-enter flex flex-col items-end">
        <div className="agent-user-bubble">{text}</div>
        {attachments?.length ? <AgentAttachmentList attachments={attachments} /> : null}
      </div>
    );
  }
  return (
    <div className="agent-feed-enter min-w-0">
      {text ? (
        <div className="agent-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml>
            {normalizeCompactAgentMarkdown(text)}
          </ReactMarkdown>
        </div>
      ) : null}
      {!streaming && text && <div className="mt-2 flex items-center gap-2"><button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-subtle hover:bg-hover hover:text-text" aria-label={t('nodeToolbar.copyText')} onClick={() => void copy()}><Copy size={13} />{t(copyState === 'copied' ? 'nodeToolbar.copied' : 'nodeToolbar.copy')}</button>{copyState === 'error' && <span role="alert" className="text-xs text-danger">{t('nodeToolbar.copyFailed')}</span>}</div>}
      {streaming ? <span className="agent-caret" role="status" aria-label={t('canvasAgent.streaming')} /> : null}
      {attachments?.length ? <AgentAttachmentList attachments={attachments} /> : null}
    </div>
  );
}

/** Reasoning summary as a quiet step; the full text stays one click away. */
export function AgentReasoning({ summary, detail, live = false }: { summary: string; detail?: string; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="agent-feed-enter min-w-0">
      <button
        type="button"
        className="agent-step"
        data-tone={live ? 'running' : undefined}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-step__icon"><BrainCircuit aria-hidden="true" /></span>
        <span className={`agent-step__detail ${live ? 'agent-shimmer' : ''}`}>{summary}</span>
        {detail ? <ChevronRight className="agent-step__chevron" aria-hidden="true" /> : null}
      </button>
      {expanded && detail ? (
        <div className="agent-step-body whitespace-pre-wrap text-xs leading-5 text-text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

export type AgentNoticeTone = 'running' | 'completed' | 'cancelled' | 'error' | 'info';

/** Turn status, stop/cancel receipts and failures; failures are alerts with their recovery actions. */
export function AgentNotice({ tone, children, actions, detail }: { tone: AgentNoticeTone; children: ReactNode; actions?: ReactNode; detail?: string }) {
  if (tone === 'error' && typeof children === 'string') return <div className="min-w-0">
    <AgentFailureNotice summary={children} detail={detail ?? children} />
    {actions ? <div className="agent-step-actions">{actions}</div> : null}
  </div>;
  const icon = tone === 'error'
    ? <CircleAlert className="mt-[3px] shrink-0" aria-hidden="true" />
    : tone === 'cancelled'
      ? <CircleStop className="mt-[3px] shrink-0" aria-hidden="true" />
      : tone === 'completed'
        ? <CheckCircle2 className="mt-[3px] shrink-0 text-success" aria-hidden="true" />
        : tone === 'running'
          ? <LoaderCircle className="mt-[3px] shrink-0 animate-spin text-accent" aria-hidden="true" />
          : null;
  return (
    <div className="agent-feed-enter min-w-0" role={tone === 'error' ? 'alert' : 'status'}>
      <p className="agent-note" data-tone={tone === 'error' ? 'danger' : undefined}>
        {icon}
        <span className={`min-w-0 flex-1 wrap-break-word ${tone === 'running' ? 'agent-shimmer' : ''}`}>{children}</span>
      </p>
      {actions ? <div className="agent-step-actions">{actions}</div> : null}
    </div>
  );
}

export function AgentEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-8 py-6 text-center">
      <span className="mb-3 text-accent" aria-hidden="true">{icon}</span>
      <p className="text-sm font-medium text-text-dark">{title}</p>
      <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
