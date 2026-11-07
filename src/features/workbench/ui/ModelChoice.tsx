import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Search, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from 'zod';
import type { CreationModel } from "./useCreationModels";

const preferenceSchema = z.object({ favorites: z.array(z.string()), recent: z.array(z.string()) });
const preferenceKey = 'storyboard:model-picker-preferences';
function readPreferences() {
  try { return preferenceSchema.parse(JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')); }
  catch { return { favorites: [], recent: [] }; }
}
type Props = {
  models: CreationModel[];
  value: string;
  onChange: (id: string) => void;
};
export function ModelChoice({ models, value, onChange }: Props) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(readPreferences);
  const [group, setGroup] = useState<'all' | 'favorites' | 'recent'>('all');
  const savePreference = (next: z.infer<typeof preferenceSchema>) => { setPreferences(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Preferences are optional; model selection remains usable. */ } };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const selected = models.find((item) => item.id === value);
  const filtered = models.filter((item) =>
    `${item.label} ${item.provider}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  ).filter((item) => group === 'all' || preferences[group].includes(item.id)).sort((a, b) => group === 'recent' ? preferences.recent.indexOf(a.id) - preferences.recent.indexOf(b.id) : a.provider.localeCompare(b.provider));
  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
        className="ui-chip max-w-64"
        data-active={open || undefined}
      >
        <Cpu />
        <span className="truncate">{selected?.label ?? t("rework.model")}</span>
        <ChevronDown className={`!h-3 !w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="ui-menu absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-40px)] origin-bottom-left p-1.5" style={{ position: "absolute" }}>
          <label className="ui-menu__search mb-1">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("rework.search")}
              aria-label={t("rework.model")}
            />
          </label>
          <div className="mb-2 flex gap-1">{(['all', 'favorites', 'recent'] as const).map((value) => <button type="button" key={value} className={`rounded-md px-3 py-1.5 text-xs ${group === value ? 'bg-raised text-text' : 'text-text-muted'}`} onClick={() => setGroup(value)}>{t(`ui.workbench.models.${value}`)}</button>)}</div>
          <div
            role="listbox"
            aria-label={t("rework.model")}
            className="ui-scrollbar max-h-72 overflow-y-auto"
          >
            {filtered.map((item, index) => (
              <Fragment key={item.id}>
              {group === 'all' && (index === 0 || filtered[index - 1].provider !== item.provider) && <p className="px-3 pb-1 pt-3 text-xs font-medium text-text-subtle">{item.provider}</p>}
              <div className="flex items-center gap-1">
              <button
                role="option"
                aria-selected={item.id === value}
                type="button"
                disabled={!item.usable}
                onClick={() => {
                  savePreference({ ...preferences, recent: [item.id, ...preferences.recent.filter((id) => id !== item.id)].slice(0, 12) });
                  onChange(item.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="ui-menu__item h-auto min-w-0 flex-1 items-start gap-3 py-2"
                data-active={item.id === value || undefined}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text-dark">
                    {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-text-subtle">
                    {item.provider}
                    {!item.usable && item.reason ? ` · ${item.reason}` : ""}
                  </span>
                </span>
                {item.id === value && (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                )}
              </button>
              <button type="button" className="mr-1 rounded-md p-2 text-text-subtle hover:text-accent" aria-pressed={preferences.favorites.includes(item.id)} aria-label={`${t('ui.workbench.models.favorite')} ${item.label}`} title={t('ui.workbench.models.favorite')} onClick={() => savePreference({ ...preferences, favorites: preferences.favorites.includes(item.id) ? preferences.favorites.filter((id) => id !== item.id) : [...preferences.favorites, item.id] })}><Star size={14} fill={preferences.favorites.includes(item.id) ? 'currentColor' : 'none'} /></button>
              </div></Fragment>
            ))}
            {!filtered.length && (
              <div className="ui-menu__empty">
                {t("rework.noMatches")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
