import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Move3d, MousePointer2, PersonStanding, Trash2 } from 'lucide-react';
import { UiButton, UiCheckbox, UiChipButton, UiIconButton, UiInput, UiSegmented, UiTextArea } from '@/components/ui';

import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import {
  AXIS_COLORS,
  itemPos,
  readUiAxis,
  uiAxisRange,
  type UiAxis,
} from './blueprintCoordinates';

/**
 * Shared right-rail "object console" used by both the canvas-embedded
 * `BlueprintNode` and the legacy popup `BlueprintPanel`. Owns no state of
 * its own — every interactive surface is driven by callbacks so the parent
 * remains the single source of truth for selection / item data / draft
 * state. This is the **only** authoritative implementation of the XYZ axis
 * sliders; it carries the `nodrag nopan` + stopPropagation belt-and-braces
 * that fixed the slider-stuck bug, so do NOT inline duplicates elsewhere.
 */
export interface BlueprintObjectConsoleProps {
  /** Full item list shown in the top "object list" picker. */
  items: BlueprintItem[];
  /** Currently selected item, or null when none. */
  selectedItem: BlueprintItem | null;
  selectedItemId: string | null;
  /** Click on the object list / 保存按钮. Pass null to clear selection. */
  onSelect: (itemId: string | null) => void;
  /** Patch arbitrary fields on an item (color, label, category, action, ...). */
  onUpdateItem: (itemId: string, patch: Partial<BlueprintItem>) => void;
  /** Coordinate-axis change. Parents must do the UI<->world Y/Z swap and
   *  legacy 2D back-fill — this component just emits the UI axis value. */
  onCoordinateChange: (itemId: string, axis: UiAxis, value: number) => void;
  onDeleteItem: (item: BlueprintItem) => void;
  /**
   * When provided, a 人/事物/场景 row is shown in the right rail so users can
   * recategorize a selected item without leaving the console. Passing
   * `undefined` hides the row (used by `BlueprintNode`, which exposes the
   * same controls in its bottom workflow tab instead).
   */
  onChangeCategory?: (itemId: string, category: 'person' | 'object' | 'scene') => void;
  /** Available @-tokens (image labels + other item names). */
  mentionTokens: string[];
  /** Append a token to the selected item's relation text at cursor end. */
  onAppendMention: (token: string) => void;
  /** Built-in + custom action labels merged. */
  actionPresets: string[];
  /** Subset of action presets that the user added themselves (deletable). */
  customActions: string[];
  onRemoveCustomAction: (action: string) => void;
  /** Viewport pose mode for the selected person (skeleton handles + pose inspector). */
  poseEditActive: boolean;
  onTogglePoseEdit: () => void;
  /** Camera-follow toggle, owned by the 3D scene parent. */
  followSelectedItem: boolean;
  onFollowChange: (next: boolean) => void;
}

export const BlueprintObjectConsole = memo(function BlueprintObjectConsole(props: BlueprintObjectConsoleProps) {
  const {
    items,
    selectedItem,
    selectedItemId,
    onSelect,
    onUpdateItem,
    onCoordinateChange,
    onDeleteItem,
    onChangeCategory,
    mentionTokens,
    onAppendMention,
    actionPresets,
    customActions,
    onRemoveCustomAction,
    poseEditActive,
    onTogglePoseEdit,
    followSelectedItem,
    onFollowChange,
  } = props;

  const handleSave = useCallback(() => onSelect(null), [onSelect]);

  return (
    <aside className="flex min-h-[740px] flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--field-bg)] p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-text-dark">对象控制台</div>
          <div className="mt-0.5 text-[10px] text-text-subtle">修改选中对象</div>
        </div>
        {selectedItem && (
          <UiButton variant="danger" size="sm" aria-label="删除当前对象"
            type="button"
            onClick={() => onDeleteItem(selectedItem)}
            className="h-7 w-7 p-0"
            title="删除当前对象"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </UiButton>
        )}
      </div>

      <ObjectListSidebar items={items} selectedItemId={selectedItemId} onSelect={onSelect} />

      {selectedItem ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
            <UiInput
              type="color"
              value={selectedItem.color}
              onChange={(event) => onUpdateItem(selectedItem.id, { color: event.target.value })}
              className="h-8 w-8 rounded-sm p-0.5"
            />
            <UiInput
              value={selectedItem.label}
              onChange={(event) => onUpdateItem(selectedItem.id, { label: event.target.value })}
              className="h-8 min-w-0 px-2.5 text-xs"
            />
          </div>

          {onChangeCategory && (
            <UiSegmented<'person' | 'object' | 'scene' | ''>
              value={selectedItem.category ?? ''}
              size="sm"
              className="w-full"
              options={([
                { value: 'person', label: '人' },
                { value: 'object', label: '事物' },
                { value: 'scene', label: '场景' },
              ] as const)}
              onChange={(cat) => { if (cat) onChangeCategory(selectedItem.id, cat); }}
            />
          )}

          {selectedItem.category !== 'scene' && (
            <AxisBlock
              selectedItem={selectedItem}
              followSelectedItem={followSelectedItem}
              onFollowChange={onFollowChange}
              onCoordinateChange={onCoordinateChange}
            />
          )}

          <RelationField
            value={selectedItem.relation ?? ''}
            mentionTokens={mentionTokens}
            onChange={(value) => onUpdateItem(selectedItem.id, { relation: value })}
            onAppendMention={onAppendMention}
          />

          {selectedItem.category === 'person' && (
            <ActionPresetGrid
              presets={actionPresets}
              customActions={customActions}
              activeAction={selectedItem.action}
              onPick={(action) => onUpdateItem(selectedItem.id, { action })}
              onRemoveCustom={onRemoveCustomAction}
              poseEditActive={poseEditActive}
              onTogglePoseEdit={onTogglePoseEdit}
            />
          )}

          <UiButton size="sm"
            type="button"
            onClick={handleSave}
            className="mt-auto text-xs"
          >
            保存
          </UiButton>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] px-4 text-center text-[11px] leading-5 text-text-subtle">
          <MousePointer2 className="mb-2 h-6 w-6 text-text-subtle" />
          选择对象后，这里会显示坐标、描述和动作。
        </div>
      )}
    </aside>
  );
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ObjectListSidebarProps {
  items: BlueprintItem[];
  selectedItemId: string | null;
  onSelect: (itemId: string | null) => void;
}

function ObjectListSidebar({ items, selectedItemId, onSelect }: ObjectListSidebarProps) {
  return (
    <div className="ui-scrollbar nowheel max-h-40 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-1.5">
      {items.length === 0 ? (
        <div className="px-2 py-6 text-center text-[11px] text-text-subtle">还没有对象</div>
      ) : (
        <div className="space-y-1">
          {items.map((item) => {
            const active = item.id === selectedItemId;
            return (
              <UiChipButton active={active}
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1 truncate text-[11px]">{item.label}</span>
              </UiChipButton>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface AxisBlockProps {
  selectedItem: BlueprintItem;
  followSelectedItem: boolean;
  onFollowChange: (next: boolean) => void;
  onCoordinateChange: (itemId: string, axis: UiAxis, value: number) => void;
}

function AxisBlock({ selectedItem, followSelectedItem, onFollowChange, onCoordinateChange }: AxisBlockProps) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3">
      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Move3d className="h-3.5 w-3.5" /> 坐标轴 <span className="text-text-subtle">· X 朝屏, Y 左右, Z 高度</span>
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-text-muted">
          <UiCheckbox
            checked={followSelectedItem}
            onCheckedChange={onFollowChange}
            className="h-3.5 w-3.5"
          />
          视角跟随
        </label>
      </div>
      <div className="space-y-3">
        {(['x', 'y', 'z'] as const).map((axis) => {
          const p = itemPos(selectedItem);
          const value = readUiAxis(p, axis);
          const { min, max } = uiAxisRange(axis);
          const color = AXIS_COLORS[axis];
          return (
            <AxisSlider
              key={axis}
              axis={axis}
              value={value}
              min={min}
              max={max}
              color={color}
              onChange={(next) => onCoordinateChange(selectedItem.id, axis, next)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface AxisSliderProps {
  axis: UiAxis;
  value: number;
  min: number;
  max: number;
  color: string;
  onChange: (next: number) => void;
}

function AxisSlider({ axis, value, min, max, color, onChange }: AxisSliderProps) {
  // The four pointer handlers + className `nodrag nopan` are the canonical
  // recipe that prevents ReactFlow from hijacking drags into pan/node-move.
  // Don't strip any of them — see commit 4aeda5e for the bug history.
  return (
    <label className="grid grid-cols-[24px_minmax(0,1fr)_72px] items-center gap-3 text-[11px] uppercase">
      <span className="text-center font-bold" style={{ color }}>{axis}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="ui-range nodrag nopan [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--axis-color)_var(--fill),var(--press)_var(--fill))] [&::-moz-range-progress]:bg-[var(--axis-color)]"
        style={{ accentColor: color, '--axis-color': color, '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
      <UiInput
        type="number"
        step={0.1}
        value={value.toFixed(1)}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="nodrag nopan h-7 min-w-0 rounded-sm px-2 text-[11px]"
      />
    </label>
  );
}

interface RelationFieldProps {
  value: string;
  mentionTokens: string[];
  onChange: (next: string) => void;
  onAppendMention: (token: string) => void;
}

/**
 * Relation textarea with an in-place `@` autocomplete dropdown plus a
 * collapsible chip row of "all available tokens" as a discoverability
 * fallback for users who don't know the keyboard syntax.
 *
 * Autocomplete contract:
 * - `mentionTokens` from the parent already include the leading `@`, e.g.
 *   `@图1`, `@对象名`. The textarea filter strips the leading `@` from the
 *   token and matches against the query the user is typing after their own
 *   `@` so that typing `@图` filters down to image tokens.
 * - The dropdown opens whenever the cursor sits inside a contiguous `@…`
 *   token (no whitespace between `@` and the cursor). Backspacing past the
 *   `@` or pressing Esc closes it without inserting.
 * - ↑ / ↓ navigate, Enter or click inserts (replacing the `@…` span the
 *   user typed), Esc cancels.
 */
function RelationField({ value, mentionTokens, onChange, onAppendMention }: RelationFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [chipRowExpanded, setChipRowExpanded] = useState(false);
  const [mention, setMention] = useState<{
    open: boolean;
    queryStart: number; // index of the `@` in `value`
    cursor: number; // selectionEnd at the time of detection
    query: string;
    activeIndex: number;
  }>({ open: false, queryStart: 0, cursor: 0, query: '', activeIndex: 0 });

  const filteredSuggestions = useMemo(() => {
    if (!mention.open) return [];
    const q = mention.query.toLowerCase();
    return mentionTokens
      .filter((token) => {
        const stripped = token.startsWith('@') ? token.slice(1) : token;
        return q === '' || stripped.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [mention.open, mention.query, mentionTokens]);

  // Clamp activeIndex when the suggestion list shrinks (e.g. user typed
  // more characters and fewer tokens match).
  useEffect(() => {
    if (!mention.open) return;
    if (mention.activeIndex >= filteredSuggestions.length && filteredSuggestions.length > 0) {
      setMention((prev) => ({ ...prev, activeIndex: filteredSuggestions.length - 1 }));
    }
  }, [filteredSuggestions.length, mention.activeIndex, mention.open]);

  const detectMention = useCallback((text: string, cursor: number) => {
    // Walk backward from cursor-1 looking for `@`. Bail on whitespace, newline,
    // or hitting the start of text without finding `@`.
    for (let i = cursor - 1; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === '@') {
        return { queryStart: i, query: text.slice(i + 1, cursor) };
      }
      if (ch === ' ' || ch === '\n' || ch === '\t') return null;
    }
    return null;
  }, []);

  const refreshMention = useCallback(
    (text: string, cursor: number) => {
      const found = detectMention(text, cursor);
      if (!found) {
        setMention((prev) => (prev.open ? { ...prev, open: false } : prev));
        return;
      }
      setMention((prev) => ({
        open: true,
        queryStart: found.queryStart,
        cursor,
        query: found.query,
        activeIndex: prev.open && prev.queryStart === found.queryStart ? prev.activeIndex : 0,
      }));
    },
    [detectMention]
  );

  const insertToken = useCallback(
    (token: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const insertion = token.endsWith(' ') ? token : `${token} `;
      const next = value.slice(0, mention.queryStart) + insertion + value.slice(mention.cursor);
      onChange(next);
      setMention((prev) => ({ ...prev, open: false }));
      // Restore caret right after the inserted token so the user can keep typing.
      const caret = mention.queryStart + insertion.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [mention.cursor, mention.queryStart, onChange, value]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      onChange(next);
      const cursor = event.target.selectionEnd ?? next.length;
      refreshMention(next, cursor);
    },
    [onChange, refreshMention]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mention.open || filteredSuggestions.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMention((prev) => ({ ...prev, activeIndex: Math.min(prev.activeIndex + 1, filteredSuggestions.length - 1) }));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMention((prev) => ({ ...prev, activeIndex: Math.max(prev.activeIndex - 1, 0) }));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const token = filteredSuggestions[mention.activeIndex];
        if (token) insertToken(token);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setMention((prev) => ({ ...prev, open: false }));
      }
    },
    [filteredSuggestions, insertToken, mention.activeIndex, mention.open]
  );

  const handleSelectOrClick = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      const cursor = target.selectionEnd ?? target.value.length;
      refreshMention(target.value, cursor);
    },
    [refreshMention]
  );

  return (
    <div className="relative space-y-1.5">
      <UiTextArea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleSelectOrClick}
        onClick={handleSelectOrClick}
        onBlur={() => {
          // Delay close so dropdown clicks register before blur kills the popup.
          setTimeout(() => setMention((prev) => ({ ...prev, open: false })), 150);
        }}
        placeholder="描述对象在干什么、和谁有关联，输入 @ 触发自动补全"
        rows={3}
        className="nodrag nowheel w-full resize-none px-2.5 py-2 text-xs"
      />

      {mention.open && filteredSuggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%-1.4rem)] z-50 max-h-44 overflow-y-auto rounded-lg border border-[var(--line)] bg-elevated py-1 shadow-[var(--shadow-pop)]">
          {filteredSuggestions.map((token, index) => {
            const active = index === mention.activeIndex;
            return (
              <UiButton variant="ghost" size="sm"
                key={token}
                type="button"
                onMouseDown={(event) => {
                  // onMouseDown prevents the textarea blur firing first.
                  event.preventDefault();
                  insertToken(token);
                }}
                onMouseEnter={() => setMention((prev) => ({ ...prev, activeIndex: index }))}
                className={`ui-menu__item h-auto min-h-0 justify-start px-3 py-1.5 text-left text-xs ${active ? 'bg-[var(--press)]' : ''}`}
              >
                {token}
              </UiButton>
            );
          })}
        </div>
      )}

      {mentionTokens.length > 0 && (
        <div className="space-y-1">
          <UiButton variant="ghost" size="sm"
            type="button"
            onClick={() => setChipRowExpanded((v) => !v)}
            className="h-auto gap-0.5 px-0 py-0.5 text-[10px]"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${chipRowExpanded ? 'rotate-180' : ''}`}
            />
            可用 @ 标签 ({mentionTokens.length})
          </UiButton>
          {chipRowExpanded && (
            <div className="flex max-h-12 flex-wrap gap-1 overflow-y-auto pr-1">
              {mentionTokens.slice(0, 16).map((token) => (
                <UiChipButton
                  key={token}
                  type="button"
                  onClick={() => onAppendMention(token)}
                  className="h-auto rounded-sm px-1.5 py-0.5 text-[10px]"
                >
                  {token}
                </UiChipButton>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ActionPresetGridProps {
  presets: string[];
  customActions: string[];
  activeAction?: string;
  onPick: (action: string) => void;
  onRemoveCustom: (action: string) => void;
  poseEditActive: boolean;
  onTogglePoseEdit: () => void;
}

function ActionPresetGrid({ presets, customActions, activeAction, onPick, onRemoveCustom, poseEditActive, onTogglePoseEdit }: ActionPresetGridProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-text-muted">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="font-semibold">动作预设</span>
        <span className="text-text-subtle">· 点击应用到当前人物</span>
      </div>
      <div className="ui-scrollbar nowheel grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
        {presets.map((action) => {
          const isCustom = customActions.includes(action);
          const isActive = activeAction === action;
          // The display label drops a "name：command" suffix so multi-line
          // custom actions stay readable in the chip.
          const displayLabel = action.length > 8 ? `${action.slice(0, 7)}…` : action;
          const fullLabel = action;
          return (
            <div
              key={action}
              className="group relative flex min-h-[44px] items-center justify-center text-xs"
              title={fullLabel}
            >
              <UiChipButton active={isActive}
                type="button"
                onClick={() => onPick(action)}
                className="h-full min-h-11 w-full flex-1 truncate rounded-md px-2 py-2 text-center text-xs"
              >
                {displayLabel}
              </UiChipButton>
              {isCustom && (
                <UiIconButton size="sm" aria-label="删除自定义动作"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveCustom(action);
                  }}
                  className="absolute right-0 top-0 h-5 w-5 rounded-bl-md opacity-0 transition-opacity hover:bg-danger/12 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  title="删除自定义动作"
                >
                  ×
                </UiIconButton>
              )}
            </div>
          );
        })}
      </div>
      <UiChipButton active={poseEditActive}
        type="button"
        onClick={onTogglePoseEdit}
        title={t('directorStudio.pose.viewportHint')}
        className="mt-2 flex h-auto w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11px]"
      >
        <PersonStanding className="h-3.5 w-3.5" />{t(poseEditActive ? 'directorStudio.pose.exit' : 'directorStudio.pose.enter')}
      </UiChipButton>
    </div>
  );
}
