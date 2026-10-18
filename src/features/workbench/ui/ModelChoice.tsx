import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CreationModel } from "./useCreationModels";

type Props = {
  models: CreationModel[];
  value: string;
  onChange: (id: string) => void;
};
export function ModelChoice({ models, value, onChange }: Props) {
  const { t } = useTranslation();
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
  );
  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
        className="flex h-9 max-w-64 items-center gap-2 rounded-lg border border-border-dark bg-bg-dark/50 px-3 text-xs text-text-dark hover:bg-surface-dark"
      >
        <span className="truncate">{selected?.label ?? t("rework.model")}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-40px)] overflow-hidden rounded-xl border border-border-dark bg-surface-dark p-2 shadow-2xl">
          <label className="mb-2 flex items-center gap-2 rounded-lg border border-border-dark px-3">
            <Search className="h-3.5 w-3.5 text-text-muted" />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("rework.search")}
              aria-label={t("rework.model")}
              className="h-9 min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none"
            />
          </label>
          <div
            role="listbox"
            aria-label={t("rework.model")}
            className="ui-scrollbar max-h-72 overflow-y-auto"
          >
            {filtered.map((item) => (
              <button
                key={item.id}
                role="option"
                aria-selected={item.id === value}
                type="button"
                disabled={!item.usable}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-text-dark/5 disabled:opacity-45"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text-dark">
                    {item.label}
                  </div>
                  <div className="mt-1 text-[11px] text-text-muted">
                    {item.provider}
                    {!item.usable && item.reason ? ` · ${item.reason}` : ""}
                  </div>
                </div>
                {item.id === value && (
                  <Check className="h-4 w-4 shrink-0 text-accent" />
                )}
              </button>
            ))}
            {!filtered.length && (
              <div className="p-4 text-xs text-text-muted">
                {t("rework.noMatches")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
