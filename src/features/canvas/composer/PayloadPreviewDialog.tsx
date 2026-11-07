import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiModal } from '@/components/ui';
import {
  previewNodeGenerationRequest,
  type GenerationRequestOptions,
} from '@/features/canvas/application/generation';
import { resolveErrorContent } from '@/features/canvas/application/errorDialog';

const INLINE_MEDIA_PREVIEW = 96;

/** Inline media (data: URLs, raw base64) would make the preview unreadable and slow; show its head and size. */
function shortenInlineMedia(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= 512) return value;
  if (value.startsWith('data:') || /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 512))) {
    return `${value.slice(0, INLINE_MEDIA_PREVIEW)}… (${value.length} chars)`;
  }
  return value;
}

/**
 * Shows the exact request a generation would send (same assembler as submit, secrets redacted by
 * the gateway preview). Read-only: nothing is submitted.
 */
export function PayloadPreviewDialog({
  nodeId,
  open,
  options,
  onClose,
}: {
  nodeId: string;
  open: boolean;
  options?: GenerationRequestOptions;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const count = options?.count;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setText(null);
    setError(null);
    previewNodeGenerationRequest(nodeId, count === undefined ? {} : { count })
      .then((preview) => {
        if (!cancelled) setText(JSON.stringify(preview, shortenInlineMedia, 2));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(resolveErrorContent(reason, t('ai.error')).message);
      });
    return () => {
      cancelled = true;
    };
  }, [count, nodeId, open, t]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <UiModal
      isOpen={open}
      title={t('node.imageEdit.payloadDebugTitle')}
      description={t('node.imageEdit.payloadDebugHint')}
      onClose={onClose}
      widthClassName="w-[min(760px,calc(100vw-32px))]"
      footer={(
        <>
          <UiButton size="sm" onClick={onClose}>{t('common.close')}</UiButton>
          <UiButton
            size="sm"
            variant="primary"
            disabled={!text}
            icon={copied ? <Check /> : <Copy />}
            onClick={() => text && void navigator.clipboard.writeText(text).then(() => setCopied(true))}
          >
            {copied ? t('nodeToolbar.copied') : t('nodeToolbar.copy')}
          </UiButton>
        </>
      )}
    >
      {error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : (
        <pre className="nowheel max-h-[60vh] overflow-auto rounded-[10px] bg-[var(--hover)] p-3 font-mono text-xs leading-5 text-text select-text">
          {text ?? t('common.loading')}
        </pre>
      )}
    </UiModal>
  );
}
