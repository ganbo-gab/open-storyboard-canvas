import { useTranslation } from 'react-i18next';

import type { ResolvedMode } from '@/features/channels/application/modelModes';
import type { RefSlot } from '@/features/channels/domain/profile';
import type { ComposerReference } from './useNodeReferences';

/** One-of-N choice as compact tiles; the popover's control for every small enum. */
export function ChoiceTiles({ options, value, label, onPick }: {
  options: readonly string[];
  value: string | undefined;
  label(option: string): string;
  onPick(option: string): void;
}) {
  return (
    <div className="ui-tiles">
      {options.map((option) => (
        <button key={option} type="button" className="ui-tile" aria-pressed={option === value} onClick={() => onPick(option)}>
          {label(option)}
        </button>
      ))}
    </div>
  );
}

/** Only models that declare their own modes get the mode / slot UI; the implicit legacy mode stays hidden. */
export function declaredChannelModes(modes: readonly ResolvedMode[] | undefined): readonly ResolvedMode[] | null {
  return modes?.length && (modes.length > 1 || modes[0].mode.id !== 'default') ? modes : null;
}

function referenceSource(reference: ComposerReference, kind: RefSlot['kind']): string | undefined {
  return kind === 'image' ? reference.imageUrl : kind === 'video' ? reference.videoUrl : reference.audioUrl;
}

/**
 * Mode tiles plus one section per declared slot, filled from the node's upstream references.
 * The caller decides what a mode switch keeps (chips, params), so preview and send stay identical.
 */
export function ChannelModeSections({ modes, active, slots, references, onModeChange, onSlotsChange }: {
  modes: readonly ResolvedMode[];
  active: ResolvedMode;
  slots: Record<string, string[]>;
  references: readonly ComposerReference[];
  onModeChange(mode: ResolvedMode): void;
  onSlotsChange(slots: Record<string, string[]>): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {modes.length > 1 ? (
        <section className="ui-popover__section">
          <div className="ui-popover__title">{t('channelModes.mode')}</div>
          <ChoiceTiles
            options={modes.map((mode) => mode.mode.id)}
            value={active.mode.id}
            label={(id) => modes.find((mode) => mode.mode.id === id)?.mode.label ?? id}
            onPick={(modeId) => {
              const next = modes.find((mode) => mode.mode.id === modeId);
              if (next) onModeChange(next);
            }}
          />
          {active.mode.description ? <p className="mt-1 text-[11.5px] leading-4 text-text-subtle">{active.mode.description}</p> : null}
        </section>
      ) : null}
      {active.slots.map((slot) => {
        const assigned = slots[slot.key] ?? [];
        const candidates = references.filter((reference) => referenceSource(reference, slot.kind));
        return (
          <section key={slot.key} className="ui-popover__section">
            <div className="ui-popover__title">
              {slot.label}{slot.min ? ' *' : ''} <span className="font-normal text-text-subtle">{assigned.length}/{slot.max}</span>
            </div>
            {candidates.length ? (
              <div className="ui-tiles">
                {candidates.map((reference) => {
                  const source = referenceSource(reference, slot.kind)!;
                  const selected = assigned.includes(source);
                  return (
                    <button
                      key={`${reference.sourceNodeId}:${reference.sourceItemId ?? ''}`}
                      type="button"
                      className="ui-tile"
                      aria-pressed={selected}
                      disabled={!selected && assigned.length >= slot.max}
                      title={reference.title}
                      onClick={() => {
                        const nextSources = selected ? assigned.filter((entry) => entry !== source) : [...assigned, source];
                        const nextSlots = { ...slots };
                        if (nextSources.length) nextSlots[slot.key] = nextSources;
                        else delete nextSlots[slot.key];
                        onSlotsChange(nextSlots);
                      }}
                    >
                      {reference.token}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11.5px] leading-4 text-text-subtle">{t('channelModes.connectForSlot', { slot: slot.label })}</p>
            )}
          </section>
        );
      })}
    </>
  );
}
