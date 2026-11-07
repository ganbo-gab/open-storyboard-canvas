import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';

/** Copies text and briefly confirms in place; clipboard failures surface through `onError`. */
export function CopyButton({ text, label, onError, size = 'sm' }: {
  text: string;
  label?: string;
  onError?: (message: string) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <UiButton
      variant="ghost"
      size={size}
      icon={copied ? <Check /> : <Copy />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1600);
        }, (cause: unknown) => onError?.(cause instanceof Error ? cause.message : String(cause)));
      }}
    >
      <span aria-live="polite">{copied ? t('ui.channels.feedback.copied') : label ?? t('ui.channels.feedback.copy')}</span>
    </UiButton>
  );
}

/** Save/test result: errors keep their full text and can be copied for an external AI or developer. */
export function ChannelFeedback({ error, notice }: { error: string; notice: string }) {
  if (error) {
    return (
      <div role="alert" className="rounded-[var(--r-md)] border border-danger/25 bg-danger/8 p-3">
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-danger">{error}</pre>
          <CopyButton text={error} />
        </div>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <p role="status" className="rounded-[var(--r-md)] border border-success/25 bg-success/8 px-3 py-2.5 text-[13px] leading-6 text-success">
      {notice}
    </p>
  );
}

/** 接入渠道 › 模板 › 配置 — every level is a button back to it. */
export function Breadcrumb({ items }: { items: { label: ReactNode; onClick?: () => void }[] }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('ui.channels.crumb.label')} className="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1">
          {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden />}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="truncate rounded-[var(--r-xs)] px-1 py-0.5 text-text-muted transition-colors hover:bg-[var(--hover)] hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              {item.label}
            </button>
          ) : (
            <span aria-current="page" className="truncate px-1 font-medium text-text">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
