import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Check, ChevronDown, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MenuLabel, MenuSeparator, MenuSurface, anchorAbove, type MenuAnchor } from '@/components/ui';
import { openSettingsDialog, type SettingsCategory } from '@/features/settings/settingsEvents';

export interface ModelOption {
  id: string;
  /** Provider / channel name; the menu groups by it. */
  group: string;
  label: string;
  usable: boolean;
  /** Why it cannot be used yet. */
  hint?: string;
}

const SEARCH_THRESHOLD = 8;

/**
 * One chip for "which model" (or voice): shows the current choice, opens a menu grouped by
 * channel with search. With nothing to choose it becomes "add …", opening the right settings page.
 */
export function ModelPickerChip({
  options,
  value,
  onChange,
  icon = <Box />,
  settingsCategory = 'providersAdd',
  placeholder,
  emptyLabel,
  manageLabel,
}: {
  options: readonly ModelOption[];
  value: string | null;
  onChange(id: string): void;
  icon?: ReactNode;
  /** Settings page that adds more options. */
  settingsCategory?: SettingsCategory;
  placeholder?: string;
  emptyLabel?: string;
  manageLabel?: string;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [query, setQuery] = useState('');
  const current = options.find((option) => option.id === value) ?? null;
  const pickLabel = placeholder ?? t('rework.canvas.composer.pickModel');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = new Map<string, ModelOption[]>();
    for (const option of options) {
      if (needle && !`${option.label} ${option.group}`.toLowerCase().includes(needle)) continue;
      const list = result.get(option.group) ?? [];
      list.push(option);
      result.set(option.group, list);
    }
    return [...result];
  }, [options, query]);

  if (options.length === 0) {
    return (
      <button
        type="button"
        className="composer-chip"
        data-active=""
        onClick={() => openSettingsDialog({ category: settingsCategory })}
      >
        <Plus />
        <span className="composer-chip__text">{emptyLabel ?? t('rework.canvas.composer.addChannel')}</span>
      </button>
    );
  }

  const close = () => {
    setAnchor(null);
    setQuery('');
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        title={current ? `${current.group} · ${current.label}` : undefined}
        onClick={() => (anchor ? close() : setAnchor(anchorAbove(triggerRef.current!)))}
      >
        {icon}
        <span className="composer-chip__text">{current?.label ?? pickLabel}</span>
        <ChevronDown />
      </button>
      {anchor ? (
        <MenuSurface anchor={anchor} width={280} label={pickLabel} onClose={close} autoFocusFirst={options.length < SEARCH_THRESHOLD}>
          {options.length >= SEARCH_THRESHOLD ? (
            <label className="ui-menu__search">
              <Search className="h-3.5 w-3.5" />
              <input
                autoFocus
                value={query}
                placeholder={t('rework.canvas.composer.searchModel')}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  const first = groups[0]?.[1].find((option) => option.usable);
                  if (event.key === 'Enter' && first) {
                    onChange(first.id);
                    close();
                  }
                }}
              />
            </label>
          ) : null}
          <div className="max-h-[320px] overflow-y-auto">
            {groups.length === 0 ? <div className="ui-menu__empty">{t('rework.noMatches')}</div> : null}
            {groups.map(([group, list]) => (
              <div key={group}>
                <MenuLabel>{group}</MenuLabel>
                {list.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    className="ui-menu__item"
                    aria-disabled={!option.usable || undefined}
                    disabled={!option.usable}
                    title={option.hint}
                    onClick={() => {
                      onChange(option.id);
                      close();
                    }}
                  >
                    <span className="ui-menu__label">
                      <span className="truncate">{option.label}</span>
                      {!option.usable && option.hint ? <span className="ui-menu__hint">{option.hint}</span> : null}
                    </span>
                    {option.id === value ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <MenuSeparator />
          <button
            type="button"
            role="menuitem"
            className="ui-menu__item"
            onClick={() => {
              close();
              openSettingsDialog({ category: settingsCategory });
            }}
          >
            <span className="ui-menu__icon"><Plus /></span>
            <span className="ui-menu__label">{manageLabel ?? t('rework.canvas.composer.manageChannels')}</span>
          </button>
        </MenuSurface>
      ) : null}
    </>
  );
}
