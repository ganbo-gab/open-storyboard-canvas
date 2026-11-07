import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Film, ImagePlus, Plus, X } from 'lucide-react';

import type { RefSlot } from '../domain/profile';
import type { ResolvedMode } from '../application/modelModes';

export interface ChannelModeControlsProps {
  modes: ResolvedMode[];
  active: ResolvedMode;
  onModeChange: (modeId: string) => void;
  /** Slot key → ordered sources (same forms the generation request accepts). */
  slots: Record<string, string[]>;
  onSlotsChange: (slots: Record<string, string[]>) => void;
  /** Parent supplies sources for a slot (file picker, canvas reference picker…). */
  onAddToSlot: (slot: RefSlot) => void;
  renderSource: (source: string, slot: RefSlot) => ReactNode;
  className?: string;
}

const SLOT_ICON = { image: ImagePlus, video: Film, audio: AudioLines } as const;

/**
 * Mode tabs and per-slot reference tiles for a channel model, in the style of
 * the 即梦 workbench: pick "文生 / 首帧 / 首尾帧 / 多参考", then fill exactly the
 * slots that mode declares. Parameters are rendered separately from the same
 * resolved mode so preview and send stay identical.
 */
export function ChannelModeControls({
  modes,
  active,
  onModeChange,
  slots,
  onSlotsChange,
  onAddToSlot,
  renderSource,
  className = '',
}: ChannelModeControlsProps) {
  const { t } = useTranslation();
  const setSlot = (key: string, sources: string[]) => {
    const next = { ...slots };
    if (sources.length) next[key] = sources;
    else delete next[key];
    onSlotsChange(next);
  };

  return (
    <div className={`space-y-2.5 ${className}`}>
      {modes.length > 1 ? (
        <div role="radiogroup" aria-label={t('channelModes.mode')} className="flex flex-wrap items-center gap-1">
          {modes.map((entry) => (
            <button
              key={entry.mode.id}
              type="button"
              role="radio"
              aria-checked={entry.mode.id === active.mode.id}
              data-active={entry.mode.id === active.mode.id || undefined}
              title={entry.mode.description}
              className="ui-chip"
              onClick={() => entry.mode.id !== active.mode.id && onModeChange(entry.mode.id)}
            >
              {entry.mode.label}
            </button>
          ))}
        </div>
      ) : null}
      {active.mode.description && modes.length > 1 ? (
        <p className="text-[11.5px] leading-5 text-text-subtle">{active.mode.description}</p>
      ) : null}
      {active.slots.length ? (
        <div className="flex flex-wrap items-start gap-3">
          {active.slots.map((slot) => {
            const sources = slots[slot.key] ?? [];
            const Icon = SLOT_ICON[slot.kind];
            const missing = sources.length < (slot.min ?? 0);
            return (
              <div key={slot.key} className="min-w-0" title={slot.description}>
                <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
                  <span>{slot.label}</span>
                  {slot.min ? <span className={missing ? 'text-warning' : 'text-text-subtle'}>*</span> : null}
                  <span className="text-text-subtle">{sources.length}/{slot.max}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {sources.map((source, index) => (
                    <span key={`${index}-${source.slice(-24)}`} className="studio-ref-tile">
                      {renderSource(source, slot)}
                      <button
                        type="button"
                        className="studio-ref-tile__remove"
                        aria-label={t('channelModes.removeFromSlot', { slot: slot.label })}
                        onClick={() => setSlot(slot.key, sources.filter((_, position) => position !== index))}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                  {sources.length < slot.max ? (
                    <button
                      type="button"
                      className="studio-ref-tile"
                      data-missing={missing || undefined}
                      aria-label={t('channelModes.addToSlot', { slot: slot.label })}
                      title={t('channelModes.addToSlot', { slot: slot.label })}
                      onClick={() => onAddToSlot(slot)}
                    >
                      {sources.length ? <Plus className="h-4 w-4" /> : <Icon className="h-[18px] w-[18px]" />}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
