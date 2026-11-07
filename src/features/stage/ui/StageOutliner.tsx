import { useState, type ReactNode } from 'react';
import { Box, Camera, ChevronRight, Eye, EyeOff, Globe2, Image, Link2, Lock, Unlock, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';

export type StageOutlinerCategory = NonNullable<BlueprintItem['category']>;
export type StageInspectorTarget = 'scene' | 'camera';

const CATEGORY_ICON: Record<StageOutlinerCategory, typeof Box> = {
  person: UserRound,
  object: Box,
  scene: Image,
};

/** Scene layers: the world, the shot camera (previs) and every item grouped by kind. */
export function StageOutliner({
  entries,
  selectedItemId,
  selectedItemIds,
  target,
  showCamera,
  cameraKeyCount,
  keyCountByItem,
  onSelectTarget,
  onSelectItem,
  onRename,
  onToggleHidden,
  onToggleLocked,
  onLinkImage,
}: {
  entries: Array<{ item: BlueprintItem; category: StageOutlinerCategory }>;
  selectedItemId: string | null;
  selectedItemIds?: readonly string[];
  target: StageInspectorTarget;
  showCamera: boolean;
  cameraKeyCount: number;
  keyCountByItem?: Record<string, number>;
  onSelectTarget: (target: StageInspectorTarget) => void;
  onSelectItem: (id: string, toggle?: boolean) => void;
  onRename: (id: string, label: string) => void;
  onToggleHidden: (item: BlueprintItem) => void;
  onToggleLocked: (item: BlueprintItem) => void;
  onLinkImage?: (item: BlueprintItem) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Partial<Record<StageOutlinerCategory, boolean>>>({});
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const groups = (['person', 'object', 'scene'] as const)
    .map((category) => ({ category, items: entries.filter((entry) => entry.category === category).map((entry) => entry.item) }))
    .filter((group) => group.items.length > 0);

  const commitRename = () => {
    if (!editing) return;
    const label = editing.label.trim();
    if (label) onRename(editing.id, label);
    setEditing(null);
  };

  const rootRow = (key: StageInspectorTarget, icon: ReactNode, label: string, help: string, count?: number) => {
    const selected = !selectedItemId && target === key;
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        className="stage-row"
        data-selected={selected || undefined}
        aria-pressed={selected}
        data-director-tooltip={help}
        onClick={() => onSelectTarget(key)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelectTarget(key);
        }}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {count ? <span className="font-mono text-[10px] text-text-subtle">◆ {count}</span> : null}
      </div>
    );
  };

  return (
    <div className="space-y-0.5 px-2 pb-2" role="list" aria-label={t('directorStudio.previs.sceneObjects')}>
      {rootRow('scene', <Globe2 className="h-3.5 w-3.5 shrink-0 text-text-subtle" />, t('directorStudio.dock.scene'), t('directorStudio.dock.sceneHelp'))}
      {showCamera ? rootRow('camera', <Camera className="h-3.5 w-3.5 shrink-0 text-accent" />, t('directorStudio.motion.timeline.camera'), t('directorStudio.previs.selectCameraHelp'), cameraKeyCount) : null}
      {groups.map(({ category, items }) => {
        const Icon = CATEGORY_ICON[category];
        const isCollapsed = collapsed[category] === true;
        return (
          <div key={category} className="pt-1.5" role="group">
            <button
              type="button"
              className="flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle transition-colors hover:text-text-muted"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((value) => ({ ...value, [category]: !isCollapsed }))}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
              {t(`directorStudio.category.${category}`)}
              <span className="ml-auto font-mono font-normal normal-case tracking-normal">{items.length}</span>
            </button>
            {isCollapsed ? null : items.map((item) => {
              const selected = selectedItemIds?.includes(item.id) ?? item.id === selectedItemId;
              const keyCount = keyCountByItem?.[item.id] ?? 0;
              const hidden = item.hidden === true;
              return (
                <div
                  key={item.id}
                  role="listitem"
                  tabIndex={0}
                  className="stage-row ml-2"
                  data-selected={selected || undefined}
                  aria-selected={selected}
                  onClick={(event) => onSelectItem(item.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                  onDoubleClick={() => { if (!item.locked) setEditing({ id: item.id, label: item.label }); }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectItem(item.id, event.shiftKey || event.metaKey || event.ctrlKey);
                    } else if (event.key === 'F2' && !item.locked) {
                      event.preventDefault();
                      setEditing({ id: item.id, label: item.label });
                    }
                  }}
                >
                  <span className="relative grid h-5 w-5 shrink-0 place-items-center rounded-md" style={{ backgroundColor: `${item.color || '#9ca3af'}26`, color: item.color || '#9ca3af' }}>
                    <Icon className="h-3 w-3" />
                  </span>
                  {editing?.id === item.id ? (
                    <input
                      autoFocus
                      value={editing.label}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditing({ id: item.id, label: event.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                      className="ui-input h-6 min-w-0 flex-1 px-1.5 text-xs"
                      aria-label={t('directorStudio.renameElementHint')}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate" data-director-tooltip={t('directorStudio.renameElementHint')}>{item.label}</span>
                  )}
                  {item.refImageUrl ? <Link2 className="h-3 w-3 shrink-0 text-accent/80" aria-label={item.refImageName ?? t('directorStudio.linkedImage.associated')} /> : null}
                  {keyCount ? <span className="shrink-0 font-mono text-[10px] text-text-subtle">◆ {keyCount}</span> : null}
                  {onLinkImage ? (
                    <button
                      type="button"
                      className="stage-row-action grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle hover:bg-[var(--press)] hover:text-text-dark"
                      aria-label={t(item.refImageUrl ? 'directorStudio.linkedImage.change' : 'directorStudio.linkedImage.choose')}
                      data-director-tooltip={t(item.refImageUrl ? 'directorStudio.linkedImage.change' : 'directorStudio.linkedImage.choose')}
                      disabled={item.locked}
                      onClick={(event) => { event.stopPropagation(); onLinkImage(item); }}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="stage-row-action grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle hover:bg-[var(--press)] hover:text-text-dark"
                    disabled={item.locked}
                    data-on={hidden || undefined}
                    aria-label={t(hidden ? 'ui.stage.selection.show' : 'ui.stage.selection.hide')}
                    data-director-tooltip={t(hidden ? 'ui.stage.selection.show' : 'ui.stage.selection.hide')}
                    onClick={(event) => { event.stopPropagation(); onToggleHidden(item); }}
                  >
                    {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" className="stage-row-action grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle hover:bg-[var(--press)]"
                    data-on={item.locked || undefined} aria-label={t(item.locked ? 'ui.stage.selection.unlock' : 'ui.stage.selection.lock')}
                    data-director-tooltip={t(item.locked ? 'ui.stage.selection.unlock' : 'ui.stage.selection.lock')}
                    onClick={(event) => { event.stopPropagation(); onToggleLocked(item); }}>
                    {item.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
      {entries.length === 0 ? <p className="px-3 py-4 text-center text-[11px] leading-5 text-text-subtle">{t('directorStudio.noElements')}</p> : null}
    </div>
  );
}
