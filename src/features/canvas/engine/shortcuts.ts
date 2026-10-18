/**
 * Single source for canvas keyboard shortcuts: the hotkey handler matches against it and the
 * shortcuts sheet / menus render from it, so labels can never drift from behaviour.
 * Chords use `mod` for ⌘ on macOS and Ctrl elsewhere.
 */
export type CanvasShortcutGroup = 'tools' | 'edit' | 'organize' | 'view';

export type CanvasShortcutId =
  | 'tool.select'
  | 'tool.hand'
  | 'node.add'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'edit.selectAll'
  | 'organize.group'
  | 'organize.ungroup'
  | 'organize.connect'
  | 'organize.tidy'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.fit'
  | 'view.actualSize'
  | 'view.palette'
  | 'view.shortcuts'
  | 'generate.run';

export interface CanvasShortcut {
  id: CanvasShortcutId;
  group: CanvasShortcutGroup;
  chords: string[];
}

export const CANVAS_SHORTCUTS: CanvasShortcut[] = [
  { id: 'tool.select', group: 'tools', chords: ['v'] },
  { id: 'tool.hand', group: 'tools', chords: ['h'] },
  { id: 'node.add', group: 'tools', chords: ['tab'] },
  { id: 'edit.undo', group: 'edit', chords: ['mod+z'] },
  { id: 'edit.redo', group: 'edit', chords: ['mod+shift+z', 'mod+y'] },
  { id: 'edit.copy', group: 'edit', chords: ['mod+c'] },
  { id: 'edit.paste', group: 'edit', chords: ['mod+v'] },
  { id: 'edit.duplicate', group: 'edit', chords: ['mod+d'] },
  { id: 'edit.delete', group: 'edit', chords: ['backspace', 'delete'] },
  { id: 'edit.selectAll', group: 'edit', chords: ['mod+a'] },
  { id: 'organize.group', group: 'organize', chords: ['mod+g'] },
  { id: 'organize.ungroup', group: 'organize', chords: ['mod+shift+g'] },
  { id: 'organize.connect', group: 'organize', chords: ['mod+l'] },
  { id: 'organize.tidy', group: 'organize', chords: ['alt+shift+f'] },
  { id: 'view.zoomIn', group: 'view', chords: ['mod+=', 'mod++'] },
  { id: 'view.zoomOut', group: 'view', chords: ['mod+-'] },
  { id: 'view.fit', group: 'view', chords: ['mod+0', 'shift+1'] },
  { id: 'view.actualSize', group: 'view', chords: ['mod+1'] },
  { id: 'view.palette', group: 'view', chords: ['mod+k', 'mod+f'] },
  { id: 'view.shortcuts', group: 'view', chords: ['?'] },
  { id: 'generate.run', group: 'edit', chords: ['mod+enter'] },
];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const KEY_LABELS: Record<string, string> = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  shift: IS_MAC ? '⇧' : 'Shift',
  alt: IS_MAC ? '⌥' : 'Alt',
  enter: '↵',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
  space: 'Space',
  escape: 'Esc',
  '=': '+',
  '+': '+',
  '-': '−',
};

export function formatChord(chord: string): string {
  const parts = chord.split('+').filter(Boolean);
  // `mod++` splits into ['mod'] with a trailing '+': restore it.
  if (chord.endsWith('++')) parts.push('+');
  const labels = parts.map((part) => KEY_LABELS[part] ?? part.toUpperCase());
  return IS_MAC ? labels.join('') : labels.join('+');
}

export function shortcutLabel(id: CanvasShortcutId): string {
  const shortcut = CANVAS_SHORTCUTS.find((item) => item.id === id);
  return shortcut ? formatChord(shortcut.chords[0]) : '';
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === ' ') return 'space';
  return lower;
}

export function eventMatchesChord(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.split('+').filter(Boolean);
  if (chord.endsWith('++')) parts.push('+');
  const key = parts[parts.length - 1];
  const wantsMod = parts.includes('mod');
  const wantsShift = parts.includes('shift');
  const wantsAlt = parts.includes('alt');
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (mod !== wantsMod || event.altKey !== wantsAlt) return false;
  // Symbol keys such as `?` or `+` already imply Shift on most layouts.
  const symbolKey = key.length === 1 && !/[a-z0-9]/.test(key);
  if (!symbolKey && event.shiftKey !== wantsShift) return false;
  if (normalizeKey(event.key) === key) return true;
  // Digits and letters by physical code survive Shift/Alt remapping.
  if (/^[a-z]$/.test(key)) return event.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}`;
  return false;
}

export function matchShortcut(event: KeyboardEvent): CanvasShortcutId | null {
  for (const shortcut of CANVAS_SHORTCUTS) {
    if (shortcut.chords.some((chord) => eventMatchesChord(event, chord))) return shortcut.id;
  }
  return null;
}
