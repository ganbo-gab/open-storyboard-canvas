import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { UiButton } from '@/components/ui';

interface TextPreviewModalProps {
  open: boolean;
  title: string;
  mode: 'markdown' | 'json';
  content: string;
  onClose: () => void;
}

export function TextPreviewModal({
  open,
  title,
  mode,
  content,
  onClose,
}: TextPreviewModalProps) {
  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center"
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        aria-label="关闭预览"
        onClick={onClose}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-[66vh] w-[66vw] flex-col overflow-hidden rounded-xl border border-[var(--canvas-node-border)] bg-[var(--canvas-node-bg)] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.1)] px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-medium text-text-dark">{title}</h2>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--canvas-node-menu-hover)] hover:text-text-dark"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 p-4">
          <div className="h-full w-full overflow-hidden rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)]">
            <div className="ui-scrollbar h-full overflow-auto p-6 text-sm leading-7 text-text-dark">
              {mode === 'json' ? (
                <pre className="whitespace-pre-wrap break-words select-text font-mono text-xs leading-6">
                  {content}
                </pre>
              ) : (
                <div className="markdown-body select-text break-words [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_p+_p]:mt-4 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end border-t border-[rgba(255,255,255,0.1)] px-4 py-3">
          <UiButton variant="muted" size="sm" onClick={onClose}>
            关闭
          </UiButton>
        </div>
      </section>
    </div>,
    document.body
  );
}
