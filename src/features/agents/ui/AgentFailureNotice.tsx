import { useEffect, useId, useState } from 'react';
import { ChevronRight, CircleAlert, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Error detail stays available without letting provider/schema JSON fill the conversation. */
export function AgentFailureNotice({ summary, detail, compact = false, tone = 'danger' }: {
  summary: string; detail: string; compact?: boolean; tone?: 'danger' | 'warning';
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setOpen(false); setCopied(false); }, [detail, compact]);
  const text = summary.replace(/\s+/g, ' ').trim();
  const brief = text.length > 180 ? `${text.slice(0, 180)}…` : text;
  return <div className="agent-failure" data-compact={compact || undefined} data-tone={tone} role={compact ? undefined : tone === 'danger' ? 'alert' : 'status'}>
    <button type="button" className="agent-failure__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <CircleAlert size={14} aria-hidden="true" />
      <span className="agent-failure__summary">{brief}</span>
      <ChevronRight size={14} className={open ? 'rotate-90' : ''} aria-hidden="true" />
    </button>
    <div className="agent-failure__actions">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={id}>{t(open ? 'ui.agent.hideError' : 'ui.agent.showError')}</button>
    </div>
    {open && <div id={id} className="agent-failure__detail">
      <pre className="agent-raw" tabIndex={0}>{detail}</pre>
      <button type="button" className="inline-flex items-center gap-1.5 text-xs text-text-muted" onClick={() => {
        void navigator.clipboard.writeText(detail).then(() => setCopied(true), () => setCopied(false));
      }}><Copy size={12} />{t(copied ? 'nodeToolbar.copied' : 'ui.agent.copyError')}</button>
    </div>}
  </div>;
}
