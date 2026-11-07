import { useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { UiSlider } from '@/components/ui';

/** Collapsible inspector section; open state is the native `<details>` state. */
export function StageSection({ title, icon, trailing, defaultOpen = true, children }: {
  title: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="stage-section group/section" open={defaultOpen}>
      <summary>
        <ChevronRight className="stage-section-caret h-3 w-3 shrink-0" />
        {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {trailing ? <span className="flex shrink-0 items-center gap-1 normal-case tracking-normal" onClick={(event) => event.preventDefault()}>{trailing}</span> : null}
      </summary>
      <div className="stage-section-body space-y-2.5">{children}</div>
    </details>
  );
}

const AXIS_TONE: Record<string, string> = {
  x: 'text-[#ff7b72]',
  y: 'text-[#7ee08f]',
  z: 'text-[#79b8ff]',
};

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  const text = String(step);
  return text.includes('.') ? Math.min(4, text.split('.')[1].length) : 2;
}

/**
 * Number field with a drag handle: drag the letter horizontally to scrub (Shift = fine),
 * type to edit (Enter commits, Esc reverts), ↑/↓ nudge by one step (Shift = ×10).
 * `onChange` streams scrub values; `onCommit` fires once per finished edit.
 */
export function ScrubNumber({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 0.1,
  precision,
  suffix,
  ariaLabel,
  tone,
  onChange,
  onCommit,
  className = '',
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  ariaLabel?: string;
  tone?: 'x' | 'y' | 'z';
  onChange?: (value: number) => void;
  onCommit: (value: number) => void;
  className?: string;
}) {
  const digits = precision ?? decimalsFor(step);
  const [draftText, setDraftText] = useState<string | null>(null);
  const draftTextRef = useRef<string | null>(null);
  const updateDraft = (value: string | null) => { draftTextRef.current = value; setDraftText(value); };
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; last: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const normalize = (next: number) => Math.min(max, Math.max(min, Number(next.toFixed(digits))));
  const shown = scrubValue ?? value;
  const displayText = draftText ?? `${Number(shown.toFixed(digits))}`;

  const commitText = () => {
    if (draftTextRef.current === null) return;
    const parsed = Number(draftTextRef.current.trim());
    updateDraft(null);
    if (!Number.isFinite(parsed)) return;
    const next = normalize(parsed);
    if (next !== normalize(value)) {
      onChange?.(next);
      onCommit(next);
    }
  };

  return (
    <div className={`stage-field ${className}`}>
      <span
        role="presentation"
        className={`stage-scrub ${tone ? AXIS_TONE[tone] : 'text-text-subtle'}`}
        data-dragging={scrubValue !== null || undefined}
        // A wrapping <label> would otherwise refocus the input after every scrub.
        onClick={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, last: value };
          setScrubValue(value);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const steps = (event.clientX - drag.startX) / 3;
          const next = normalize(drag.startValue + steps * step * (event.shiftKey ? 0.1 : 1));
          if (next === drag.last) return;
          drag.last = next;
          setScrubValue(next);
          onChange?.(next);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setScrubValue(null);
          if (drag.last !== normalize(drag.startValue)) onCommit(drag.last);
          else inputRef.current?.focus();
        }}
        onPointerCancel={() => {
          const drag = dragRef.current;
          dragRef.current = null;
          setScrubValue(null);
          if (drag && onChange) onChange(drag.startValue);
        }}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        data-stage-field
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel ?? label}
        value={displayText}
        onFocus={(event) => { updateDraft(`${Number(value.toFixed(digits))}`); event.currentTarget.select(); }}
        onChange={(event) => updateDraft(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commitText();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            updateDraft(null);
            event.currentTarget.blur();
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const base = Number(draftText ?? value);
            const next = normalize((Number.isFinite(base) ? base : value) + (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1));
            updateDraft(`${next}`);
            onChange?.(next);
            onCommit(next);
            draftTextRef.current = null;
          }
        }}
      />
      {suffix ? <span className="pr-1.5 text-[10px] text-text-subtle">{suffix}</span> : null}
    </div>
  );
}

/** Labelled X/Y/Z row with colour-coded scrub handles. */
export function VectorField({ label, value, min, max, step = 0.1, suffix, onChange, onCommit }: {
  label: string;
  value: { x: number; y: number; z: number };
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange?: (axis: 'x' | 'y' | 'z', value: number) => void;
  onCommit: (axis: 'x' | 'y' | 'z', value: number) => void;
}) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[11px] text-text-muted">{label}</span>
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <ScrubNumber
            key={axis}
            label={axis.toUpperCase()}
            tone={axis}
            ariaLabel={`${label} ${axis.toUpperCase()}`}
            value={value[axis]}
            min={min}
            max={max}
            step={step}
            suffix={suffix}
            onChange={onChange ? (next) => onChange(axis, next) : undefined}
            onCommit={(next) => onCommit(axis, next)}
          />
        ))}
      </div>
    </div>
  );
}

/** Slider + exact field on one row; both stream live values. */
export function SliderField({ label, value, min, max, step, suffix, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_64px] items-center gap-2">
      <span className="truncate text-[11px] text-text-muted">{label}</span>
      <UiSlider aria-label={label} min={min} max={max} step={step} value={value} onChange={onChange} className="min-w-0" />
      <ScrubNumber label="↔" ariaLabel={label} value={value} min={min} max={max} step={step} suffix={suffix} onChange={onChange} onCommit={onChange} />
    </div>
  );
}

export function StageEmpty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--hover)] text-text-subtle">{icon}</div> : null}
      <div className="text-xs font-medium text-text-dark">{title}</div>
      {hint ? <p className="text-[11px] leading-5 text-text-subtle">{hint}</p> : null}
      {action}
    </div>
  );
}
