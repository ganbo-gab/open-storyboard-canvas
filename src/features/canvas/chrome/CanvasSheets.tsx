import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Search, X } from 'lucide-react';

import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import {
  CANVAS_SHORTCUTS,
  formatChord,
  shortcutLabel,
  type CanvasShortcutGroup,
  type CanvasShortcutId,
} from '@/features/canvas/engine/shortcuts';
import { ADD_NODE_CATALOG } from '@/features/canvas/menus/addNodeCatalog';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

function SheetScrim({ onClose, children, align = 'top' }: { onClose: () => void; children: ReactNode; align?: 'top' | 'center' }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);
  return createPortal(
    <div
      className={`canvas-sheet-scrim ${align === 'top' ? 'is-top' : ''}`}
      data-canvas-overlay=""
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body
  );
}

interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
}

/** ⌘K: jump to any node (by name or prompt) or run any canvas command. */
export function CanvasCommandPalette() {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const setSheet = useCanvasUiStore((state) => state.setSheet);
  const nodes = useCanvasStore((state) => state.nodes);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setSheet(null);

  const entries = useMemo<PaletteEntry[]>(() => {
    const needle = query.trim().toLowerCase();
    const commandEntries: PaletteEntry[] = [
      ...ADD_NODE_CATALOG.map((entry) => ({
        id: `add:${entry.type}`,
        label: `${t('rework.canvas.palette.addPrefix')} ${t(entry.labelKey)}`,
        hint: t(entry.hintKey),
        run: () => actions.createNode(entry.type, undefined, entry.configuration),
      })),
      { id: 'organize', label: t('rework.canvas.organize'), run: actions.organizeCanvas },
      { id: 'fit', label: t('rework.canvas.fit'), shortcut: shortcutLabel('view.fit'), run: actions.fitView },
      { id: 'zoom100', label: '100%', shortcut: shortcutLabel('view.actualSize'), run: () => actions.zoomTo(1) },
      { id: 'selectAll', label: t('rework.canvas.menu.selectAll'), shortcut: shortcutLabel('edit.selectAll'), run: actions.selectAll },
      { id: 'shortcuts', label: t('rework.canvas.shortcuts'), shortcut: shortcutLabel('view.shortcuts'), run: () => setSheet('shortcuts') },
      { id: 'settings', label: t('rework.settings'), run: () => openSettingsDialog() },
    ];
    const nodeEntries: PaletteEntry[] = nodes.map((node) => {
      const name = resolveNodeDisplayName(node.type, node.data);
      const prompt = 'prompt' in node.data && typeof node.data.prompt === 'string' ? node.data.prompt : '';
      return {
        id: `node:${node.id}`,
        label: name,
        hint: prompt.slice(0, 80) || undefined,
        run: () => {
          useCanvasStore.getState().setSelectedNode(node.id);
          actions.focusNodes([node.id]);
        },
      };
    });
    const matches = (entry: PaletteEntry) => !needle || `${entry.label} ${entry.hint ?? ''}`.toLowerCase().includes(needle);
    return [...nodeEntries.filter(matches).slice(0, needle ? 30 : 8), ...commandEntries.filter(matches)];
  }, [actions, nodes, query, setSheet, t]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runEntry = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    close();
    entry.run();
  };

  return (
    <SheetScrim onClose={close}>
      <section role="dialog" aria-label={t('rework.canvas.commands')} className="canvas-palette">
        <label className="canvas-palette__search">
          <Search className="h-4 w-4" />
          <input
            autoFocus
            value={query}
            placeholder={t('rework.canvas.search')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(entries.length - 1, index + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
              if (event.key === 'Enter') { event.preventDefault(); runEntry(entries[active]); }
            }}
          />
          <kbd className="ui-kbd">Esc</kbd>
        </label>
        <div ref={listRef} className="canvas-palette__list" role="listbox">
          {entries.length === 0 ? <div className="ui-menu__empty">{t('rework.noMatches')}</div> : null}
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-index={index}
              className="canvas-palette__item"
              onPointerMove={() => setActive(index)}
              onClick={() => runEntry(entry)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.label}</span>
                {entry.hint ? <span className="block truncate text-[11.5px] text-text-subtle">{entry.hint}</span> : null}
              </span>
              {entry.shortcut ? <kbd className="ui-kbd">{entry.shortcut}</kbd> : null}
              {index === active ? <CornerDownLeft className="h-3.5 w-3.5 text-text-subtle" /> : null}
            </button>
          ))}
        </div>
      </section>
    </SheetScrim>
  );
}

const GROUP_ORDER: CanvasShortcutGroup[] = ['tools', 'edit', 'organize', 'view'];

const GESTURES: Array<{ labelKey: string; keys: string[] }> = [
  { labelKey: 'rework.canvas.gestures.multi', keys: ['rework.canvas.gestures.multiKeys'] },
  { labelKey: 'rework.canvas.gestures.copyDrag', keys: ['rework.canvas.gestures.copyDragKeys'] },
];

/** `?`: every shortcut in four columns plus the mouse/trackpad gestures, filterable. */
export function CanvasShortcutsSheet() {
  const { t } = useTranslation();
  const bindings = useSettingsStore((state) => state.canvasMouseBindings);
  const wheelMode = useSettingsStore((state) => state.canvasWheelMode);
  const mouseGestures = Object.entries(bindings).map(([slot, action]) => ({
    labelKey: `settings.canvasInteraction.slots.${slot}`, keys: [`settings.canvasInteraction.actions.${action}`],
  }));
  mouseGestures.push({ labelKey: 'settings.canvasInteraction.wheel', keys: [`settings.canvasInteraction.wheelOptions.${wheelMode}`] });
  const setSheet = useCanvasUiStore((state) => state.setSheet);
  const [query, setQuery] = useState('');
  const close = () => setSheet(null);
  const needle = query.trim().toLowerCase();
  const label = (id: CanvasShortcutId) => t(`rework.canvas.shortcutNames.${id}`);

  return (
    <SheetScrim onClose={close} align="center">
      <section role="dialog" aria-label={t('rework.canvas.shortcuts')} className="canvas-shortcuts">
        <header className="canvas-shortcuts__header">
          <h2>{t('rework.canvas.shortcuts')}</h2>
          <label className="canvas-shortcuts__filter">
            <Search className="h-3.5 w-3.5" />
            <input autoFocus value={query} placeholder={t('rework.search')} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" className="canvas-tool" aria-label={t('rework.close')} onClick={close}>
            <X />
          </button>
        </header>
        <div className="canvas-shortcuts__grid">
          {GROUP_ORDER.map((group) => {
            const items = CANVAS_SHORTCUTS.filter((item) => item.group === group && (!needle || label(item.id).toLowerCase().includes(needle)));
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <h3>{t(`rework.canvas.shortcutGroups.${group}`)}</h3>
                {items.map((item) => (
                  <div key={item.id} className="canvas-shortcuts__row">
                    <span>{label(item.id)}</span>
                    <span className="flex gap-1">
                      {item.chords.slice(0, 1).map((chord) => <kbd key={chord} className="ui-kbd">{formatChord(chord)}</kbd>)}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          <div>
            <h3>{t('rework.canvas.shortcutGroups.gestures')}</h3>
            {[...mouseGestures, ...GESTURES].filter((gesture) => !needle || t(gesture.labelKey).toLowerCase().includes(needle)).map((gesture) => (
              <div key={gesture.labelKey} className="canvas-shortcuts__row">
                <span>{t(gesture.labelKey)}</span>
                <span className="text-right text-text-subtle">{gesture.keys.map((key) => t(key)).join(' / ')}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </SheetScrim>
  );
}
