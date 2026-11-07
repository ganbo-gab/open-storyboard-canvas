import { memo, useState, useEffect } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { UiButton, UiIconButton, UiTextArea } from '@/components/ui';

interface PromptTemplateDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  value: string;
  defaultValue: string;
  placeholders: string[];
  onClose: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  onResetDefault: () => void;
}

export const PromptTemplateDialog = memo(({
  isOpen,
  title,
  description,
  value,
  defaultValue,
  placeholders,
  onClose,
  onChange,
  onSave,
  onResetDefault,
}: PromptTemplateDialogProps) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (isOpen) {
      setDraft(value);
    }
  }, [isOpen, value]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-300 flex items-center justify-center bg-[var(--scrim)] p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="w-[560px] max-w-full rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <span className="text-sm font-semibold text-text-dark">{title}</span>
          <UiIconButton size="sm"
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-6 w-6 items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" />
          </UiIconButton>
        </div>

        <div className="space-y-3 px-5 py-4">
          {description && (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--hover)] px-3 py-2 text-[12px] leading-5 text-text-muted">
              {description}
            </div>
          )}
          <div className="rounded-lg border border-[var(--line)] bg-[var(--hover)] px-3 py-2">
            <div className="text-[11px] font-medium text-text-muted">可用占位符</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {placeholders.map((placeholder) => (
                <span
                  key={placeholder}
                  className="rounded-md bg-[var(--hover)] px-2 py-1 text-[11px] text-text-muted"
                >
                  {placeholder}
                </span>
              ))}
            </div>
          </div>

          <UiTextArea
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              onChange(next);
            }}
            className="h-48 w-full resize-none rounded-lg px-3 py-2 text-sm leading-6"
          />

          <div className="rounded-lg border border-[var(--line)] bg-[var(--hover)] px-3 py-2 text-[11px] leading-5 text-text-subtle">
            默认模板：<span className="text-text-muted">{defaultValue}</span>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
          <UiButton variant="ghost" size="sm"
            type="button"
            onClick={() => {
              setDraft(defaultValue);
              onChange(defaultValue);
              onResetDefault();
            }}
            className="flex items-center gap-1.5 text-xs"
          >
            <RotateCcw className="h-3 w-3" />
            恢复默认
          </UiButton>

          <div className="flex items-center gap-2">
            <UiButton variant="secondary" size="sm"
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs"
            >
              关闭
            </UiButton>
            <UiButton variant="primary" size="sm"
              type="button"
              onClick={() => {
                onChange(draft);
                onSave();
                onClose();
              }}
              className="rounded-md px-3 py-1.5 text-xs font-medium"
            >
              保存
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  );
});

PromptTemplateDialog.displayName = 'PromptTemplateDialog';
