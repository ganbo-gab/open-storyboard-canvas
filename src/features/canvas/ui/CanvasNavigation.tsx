import { useEffect, useRef, useState } from "react";
import {
  Map as MapIcon,
  Maximize2,
  Search,
  Undo2,
  Redo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useReactFlow, useViewport } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useCanvasStore } from "@/stores/canvasStore";
import { resolveNodeDisplayName } from "../domain/nodeDisplay";
import { canvasCommandRegistry } from "../application/canvasCommandService";
import { CANVAS_COMMAND_VERSION } from "../domain/canvasCommands";

type Props = {
  mode: "select" | "hand";
  onMode: (mode: "select" | "hand") => void;
  onAdd: () => void;
  shortcutSignal?: number;
  minimap: boolean;
  onMinimap: (open: boolean) => void;
};
export function CanvasNavigation({ onMode, onAdd, shortcutSignal = 0, minimap, onMinimap }: Props) {
  const { t } = useTranslation();
  const { zoom } = useViewport();
  const flow = useReactFlow();
  const nodes = useCanvasStore((state) => state.nodes);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const history = useCanvasStore((state) => state.history);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [shortcuts, setShortcuts] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (searchOpen || shortcuts)) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(false);
        setShortcuts(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen((value) => !value);
        return;
      }
      if (
        (event.target as HTMLElement)?.closest(
          'input,textarea,[contenteditable="true"]',
        )
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "v") onMode("select");
      if (event.key.toLowerCase() === "h") onMode("hand");
      if (event.key === "?") {
        event.preventDefault();
        setShortcuts((value) => !value);
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onMode, searchOpen, shortcuts]);
  useEffect(() => {
    if (shortcutSignal > 0) setShortcuts(true);
  }, [shortcutSignal]);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const matches = nodes.filter((node) =>
    resolveNodeDisplayName(node.type, node.data)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div
        data-canvas-no-marquee="true"
        className="canvas-dock"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          disabled={!history.past.length}
          title={t("rework.canvas.undo")}
          aria-label={t("rework.canvas.undo")}
          onClick={() => undo()}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={!history.future.length}
          title={t("rework.canvas.redo")}
          aria-label={t("rework.canvas.redo")}
          onClick={() => redo()}
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <span className="canvas-dock__rule" />
        <button
          type="button"
          title={t("rework.canvas.zoomOut")}
          aria-label={t("rework.canvas.zoomOut")}
          onClick={() => void flow.zoomOut({ duration: 150 })}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void flow.zoomTo(1, { duration: 200 })}
          className="canvas-dock__zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          title={t("rework.canvas.zoomIn")}
          aria-label={t("rework.canvas.zoomIn")}
          onClick={() => void flow.zoomIn({ duration: 150 })}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("rework.canvas.fit")}
          aria-label={t("rework.canvas.fit")}
          onClick={() => void flow.fitView({ duration: 250, padding: 0.2 })}
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("rework.canvas.minimap")}
          aria-label={t("rework.canvas.minimap")}
          aria-pressed={minimap}
          onClick={() => onMinimap(!minimap)}
        >
          <MapIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="⌘K"
          aria-label={t("rework.canvas.commands")}
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-4 w-4" />
        </button>
      </div>
      {nodes.length === 0 && (
        <div className="canvas-empty">
          <span>{t("rework.canvas.empty")}</span>
          <span>{t("rework.canvas.emptyHint")}</span>
        </div>
      )}
      {searchOpen && (
        <div
          className="absolute inset-0 z-[14000] flex items-start justify-center bg-black/25 px-4 pt-[12vh] backdrop-blur-xs"
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.currentTarget === event.target) setSearchOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-label={t("rework.canvas.commands")}
            className="canvas-command w-full max-w-lg overflow-hidden"
          >
            <div className="flex items-center gap-3 border-b border-border-dark px-4">
              <Search className="h-4 w-4 text-text-muted" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t("rework.canvas.search")}
                placeholder={t("rework.canvas.search")}
                className="h-14 min-w-0 flex-1 bg-transparent text-sm text-text-dark outline-none"
              />
              <button
                type="button"
                aria-label={t("rework.close")}
                onClick={() => setSearchOpen(false)}
                className="p-2 text-text-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              <button
                type="button"
                onClick={() => {
                  onAdd();
                  setSearchOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-xs text-text-dark hover:bg-bg-dark"
              >
                + {t("rework.canvas.add")}
              </button>
              {matches.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => {
                    void canvasCommandRegistry.execute(
                      {
                        type: "selection.set",
                        version: CANVAS_COMMAND_VERSION,
                        input: { nodeIds: [node.id] },
                      },
                      "ui",
                    );
                    void flow.fitView({
                      nodes: [{ id: node.id }],
                      duration: 250,
                      maxZoom: 1,
                      padding: 0.3,
                    });
                    setSearchOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left text-xs text-text-dark hover:bg-bg-dark"
                >
                  <span className="truncate">
                    {resolveNodeDisplayName(node.type, node.data)}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {node.type}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {shortcuts && (
        <div
          className="absolute inset-0 z-[14000] flex items-center justify-center bg-black/25 p-4 backdrop-blur-xs"
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.currentTarget === event.target) setShortcuts(false);
          }}
        >
          <section
            role="dialog"
            aria-label={t("rework.canvas.shortcuts")}
            className="canvas-shortcuts w-full max-w-xl p-6"
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-dark">
                {t("rework.canvas.shortcuts")}
              </h2>
              <button
                type="button"
                onClick={() => setShortcuts(false)}
                aria-label={t("rework.close")}
              >
                <X className="h-4 w-4 text-text-muted" />
              </button>
            </div>
            <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {[
                ["V", "select"],
                ["H", "hand"],
                ["⌘K", "commands"],
                ["⌘Z", "undo"],
                ["⌘⇧Z", "redo"],
                ["?", "shortcuts"],
              ].map(([key, label]) => (
                <div
                  key={key}
                  className="flex items-center justify-between text-xs text-text-muted"
                >
                  <span>{t(`rework.canvas.${label}`)}</span>
                  <kbd className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 font-mono text-text-dark">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
            <p className="mt-6 border-t border-border-dark pt-4 text-xs leading-6 text-text-muted">
              {t("rework.canvas.keyboardHint")}
            </p>
          </section>
        </div>
      )}
    </>
  );
}
