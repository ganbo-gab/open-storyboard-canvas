import { memo, useState, useEffect } from 'react';
import { RotateCcw, X } from 'lucide-react';

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
    <div className="fixed inset-0 z-300 flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="w-[560px] rounded-xl border border-[rgba(255,255,255,0.1)] bg-[#1b1b1b] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-5 py-3.5">
          <span className="text-sm font-semibold text-white">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {description && (
            <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-2 text-[12px] leading-5 text-white/62">
              {description}
            </div>
          )}
          <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-2">
            <div className="text-[11px] font-medium text-white/55">可用占位符</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {placeholders.map((placeholder) => (
                <span
                  key={placeholder}
                  className="rounded-md bg-[rgba(255,255,255,0.07)] px-2 py-1 text-[11px] text-white/72"
                >
                  {placeholder}
                </span>
              ))}
            </div>
          </div>

          <textarea
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              onChange(next);
            }}
            className="h-48 w-full resize-none rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] px-3 py-2 text-sm leading-6 text-white/85 outline-hidden transition-colors focus:border-[rgba(255,255,255,0.2)]"
          />

          <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-2 text-[11px] leading-5 text-white/45">
            默认模板：<span className="text-white/65">{defaultValue}</span>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[rgba(255,255,255,0.08)] px-5 py-3">
          <button
            type="button"
            onClick={() => {
              setDraft(defaultValue);
              onChange(defaultValue);
              onResetDefault();
            }}
            className="flex items-center gap-1.5 text-xs text-white/45 transition-colors hover:text-white"
          >
            <RotateCcw className="h-3 w-3" />
            恢复默认
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-[rgba(255,255,255,0.08)] px-3 py-1.5 text-xs text-white/72 transition-colors hover:bg-[rgba(255,255,255,0.12)]"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(draft);
                onSave();
                onClose();
              }}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

PromptTemplateDialog.displayName = 'PromptTemplateDialog';
