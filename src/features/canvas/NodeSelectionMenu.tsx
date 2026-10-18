import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Image,
  Images,
  Upload,
  Sparkles,
  LayoutGrid,
  Tag,
  Tags,
  Type,
  Video,
  Music2,
  Search,
} from "lucide-react";
import type { CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { nodeCatalog } from "@/features/canvas/application/nodeCatalog";
import type { MenuIconKey } from "@/features/canvas/domain/nodeRegistry";

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  showAssetOption?: boolean;
  onSelectAsset?: () => void;
  onSelect: (type: CanvasNodeType) => void;
  onClose: () => void;
}
const iconMap: Record<MenuIconKey, typeof Upload> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
  audio: Music2,
  tag: Tag,
  tagGroup: Tags,
};

export function NodeSelectionMenu({
  position,
  allowedTypes,
  showAssetOption = false,
  onSelectAsset,
  onSelect,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState(position);
  const items = useMemo(() => {
    const candidates = allowedTypes
      ? [...new Set(allowedTypes)].map((type) =>
          nodeCatalog.getDefinition(type),
        )
      : nodeCatalog.getMenuDefinitions();
    const result: typeof candidates = [];
    for (const candidate of candidates) {
      const index = result.findIndex(
        (item) => item.menuLabelKey === candidate.menuLabelKey,
      );
      if (index < 0) result.push(candidate);
      else if (!result[index].visibleInMenu && candidate.visibleInMenu)
        result[index] = candidate;
    }
    return result.filter((item) =>
      t(item.menuLabelKey).toLowerCase().includes(query.toLowerCase()),
    );
  }, [allowedTypes, query, t]);
  useEffect(() => {
    input.current?.focus();
    const element = menu.current;
    const container = element?.offsetParent;
    if (element && container) {
      const rect = element.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      setPlacement({
        x: Math.max(12, Math.min(position.x, bounds.width - rect.width - 12)),
        y: Math.max(12, Math.min(position.y, bounds.height - rect.height - 12)),
      });
    }
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose, position.x, position.y]);
  return (
    <div
      ref={menu}
      role="dialog"
      aria-label={t("rework.canvas.add")}
      data-canvas-no-marquee="true"
      className="absolute z-[14000] w-64 overflow-hidden rounded-xl border border-border-dark bg-surface-dark p-2 shadow-2xl"
      style={{
        left: placement.x,
        top: placement.y,
        maxWidth: "calc(100% - 24px)",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((value) => Math.min(items.length - 1, value + 1));
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((value) => Math.max(0, value - 1));
        }
        if (event.target === input.current && event.key === 'Enter' && items[active]) {
          event.preventDefault();
          event.stopPropagation();
          onSelect(items[active].type);
          onClose();
        }
      }}
    >
      <label className="mb-2 flex items-center gap-2 border-b border-border-dark px-2 pb-2">
        <Search className="h-3.5 w-3.5 text-text-muted" />
        <input
          ref={input}
          aria-label={t("rework.search")}
          placeholder={t("rework.search")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          className="h-8 min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none"
        />
      </label>
      <div className="ui-scrollbar max-h-[min(420px,55vh)] overflow-y-auto">
        {items.map((item, index) => {
          const Icon = iconMap[item.menuIcon] ?? Image;
          return (
            <button
              key={item.type}
              type="button"
              onPointerEnter={() => setActive(index)}
              onClick={() => {
                onSelect(item.type);
                onClose();
              }}
              className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-xs text-text-dark transition-colors ${index === active ? "bg-text-dark/7" : "hover:bg-text-dark/4"}`}
            >
              <Icon className="h-4 w-4 shrink-0 text-text-muted" />
              <span>{t(item.menuLabelKey)}</span>
            </button>
          );
        })}
        {!items.length && (
          <p className="p-3 text-xs text-text-muted">{t("rework.noMatches")}</p>
        )}
      </div>
      {showAssetOption && onSelectAsset && (
        <button
          type="button"
          onClick={() => {
            onSelectAsset();
            onClose();
          }}
          className="mt-2 flex h-10 w-full items-center gap-3 rounded-lg border-t border-border-dark px-3 text-xs text-text-dark hover:bg-text-dark/5"
        >
          <Images className="h-4 w-4 text-text-muted" />
          {t("canvasToolbar.assets")}
        </button>
      )}
    </div>
  );
}
