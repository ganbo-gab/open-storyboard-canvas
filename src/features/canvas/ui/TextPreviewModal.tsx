import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ImagePlus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { UiButton, UiIconButton } from '@/components/ui';

interface TextPreviewModalProps {
  open: boolean;
  title: string;
  mode: 'markdown' | 'json';
  content: string;
  onClose: () => void;
  onCreateImageFromSelectedText?: (selectedText: string) => void;
}

export function TextPreviewModal({
  open,
  title,
  mode,
  content,
  onClose,
  onCreateImageFromSelectedText,
}: TextPreviewModalProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selectedText: string;
  } | null>(null);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const openSelectedTextMenu = (event: ReactMouseEvent) => {
    const selectedText = window.getSelection()?.toString().trim() ?? '';
    if (!selectedText) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      selectedText,
    });
  };

  const copySelectedText = async () => {
    const selectedText = contextMenu?.selectedText.trim();
    if (!selectedText) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selectedText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = selectedText;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
    } finally {
      setContextMenu(null);
    }
  };

  const createImageFromSelectedText = () => {
    const selectedText = contextMenu?.selectedText.trim();
    if (!selectedText) {
      return;
    }
    onCreateImageFromSelectedText?.(selectedText);
    setContextMenu(null);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-220 flex items-center justify-center"
      onMouseDown={() => setContextMenu(null)}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="absolute inset-0 bg-(--scrim) focus-visible:outline-2 focus-visible:outline-accent"
        aria-label="关闭预览"
        onClick={onClose}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-[66vh] w-[66vw] flex-col overflow-hidden rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-bg) shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-(--canvas-node-divider) px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-medium text-text-dark">{title}</h2>
          <UiIconButton variant="ghost"
            type="button"
            className="h-8 w-8 shrink-0 rounded-md"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </UiIconButton>
        </div>

        <div className="min-h-0 flex-1 p-4">
          <div className="h-full w-full overflow-hidden rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-field-bg)">
            <div className="ui-scrollbar h-full overflow-auto p-6 text-sm leading-7 text-text-dark">
              {mode === 'json' ? (
                <pre
                  className="whitespace-pre-wrap wrap-break-word select-text font-mono text-xs leading-6"
                  onContextMenu={openSelectedTextMenu}
                >
                  {content}
                </pre>
              ) : (
                <div
                  className="markdown-body select-text wrap-break-word [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-(--line-strong) [&_blockquote]:pl-3 [&_code]:rounded-sm [&_code]:bg-(--press) [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_p+_p]:mt-4 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-(--canvas-node-subtle-bg) [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
                  onContextMenu={openSelectedTextMenu}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end border-t border-(--canvas-node-divider) px-4 py-3">
          <UiButton variant="secondary" size="sm" onClick={onClose}>
            关闭
          </UiButton>
        </div>
      </section>

      {contextMenu ? (
        <div
          className="fixed z-230 min-w-32 overflow-hidden rounded-md border border-(--canvas-node-border) bg-(--canvas-node-menu-bg) py-1 text-sm text-text-dark shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <UiButton variant="ghost"
            type="button"
            className="h-auto w-full justify-start gap-2 px-3 py-2 text-left"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void copySelectedText();
            }}
          >
            <Copy className="h-4 w-4" />
            复制文本
          </UiButton>
          {onCreateImageFromSelectedText ? (
            <UiButton variant="ghost"
              type="button"
              className="h-auto w-full justify-start gap-2 px-3 py-2 text-left"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                createImageFromSelectedText();
              }}
            >
              <ImagePlus className="h-4 w-4" />
              生成图片
            </UiButton>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body
  );
}
