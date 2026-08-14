import { memo, useEffect, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Eye, Frame, Power, RectangleHorizontal, Scan, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiChipButton, UiPanel } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  TAG_COLORS,
  type TagColor,
  type TagGroupNodeData,
  type TagGroupShape,
} from '@/features/canvas/domain/canvasNodes';
import { TagRelationsDialog } from '@/features/canvas/nodes/TagRelationsDialog';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

type TagGroupToolbarProps = {
  nodeId: string;
  data: TagGroupNodeData;
};

const COLOR_VARIABLES: Record<TagColor, string> = {
  neutral: 'var(--tag-color-neutral)',
  amber: 'var(--tag-color-amber)',
  cyan: 'var(--tag-color-cyan)',
  violet: 'var(--tag-color-violet)',
  rose: 'var(--tag-color-rose)',
};

const SHAPES: Array<{ value: TagGroupShape; icon: typeof Frame }> = [
  { value: 'rectangle', icon: RectangleHorizontal },
  { value: 'rounded', icon: Scan },
  { value: 'frame', icon: Frame },
];

export const TagGroupToolbar = memo(({ nodeId, data }: TagGroupToolbarProps) => {
  const { t } = useTranslation();
  const [name, setName] = useState(data.displayName ?? data.label);
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(data.displayName ?? data.label), [data.displayName, data.label]);

  const run = async (command: Parameters<typeof canvasCommandRegistry.execute>[0]) => {
    const result = await canvasCommandRegistry.execute(command, 'ui');
    setError(result.ok ? null : result.error.message);
  };

  const saveName = () => {
    const displayName = name.trim();
    if (!displayName || displayName === (data.displayName ?? data.label)) return;
    void run({ type: 'node.rename', version: CANVAS_COMMAND_VERSION, input: { nodeId, displayName } });
  };

  return (
    <>
      <ReactFlowNodeToolbar nodeId={nodeId} isVisible position={NODE_TOOLBAR_POSITION} align={NODE_TOOLBAR_ALIGN} offset={NODE_TOOLBAR_OFFSET} className={NODE_TOOLBAR_CLASS}>
        <UiPanel className="flex max-w-[760px] items-center gap-1 rounded-full p-1 shadow-xl">
          <input
            value={name}
            aria-label={t('node.tag.groupName')}
            className="nodrag h-8 w-32 rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] px-3 text-xs text-text-dark outline-none focus:border-accent"
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          <div className="flex items-center gap-0.5 px-1" aria-label={t('node.tag.colorLabel')}>
            {TAG_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${data.color === color ? 'border-text-dark' : 'border-transparent'}`}
                style={{ backgroundColor: COLOR_VARIABLES[color] }}
                aria-label={t(`node.tag.colors.${color}`)}
                onClick={() => void run({ type: 'tagGroup.setAppearance', version: CANVAS_COMMAND_VERSION, input: { groupId: nodeId, color } })}
              />
            ))}
          </div>
          <div className="flex items-center gap-0.5 border-l border-[var(--canvas-node-divider)] pl-1">
            {SHAPES.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${data.shape === value ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-[var(--canvas-node-menu-hover)]'}`}
                aria-label={t(`node.tag.shapes.${value}`)}
                title={t(`node.tag.shapes.${value}`)}
                onClick={() => void run({ type: 'tagGroup.setAppearance', version: CANVAS_COMMAND_VERSION, input: { groupId: nodeId, shape: value } })}
              ><Icon className="h-3.5 w-3.5" /></button>
            ))}
          </div>
          <UiChipButton className="h-8 rounded-full px-2.5 text-xs" onClick={() => setIsMembersOpen(true)} title={t('node.tag.viewMembers')}>
            <Eye className="h-3.5 w-3.5" />{t('node.tag.view')}
          </UiChipButton>
          <UiChipButton className="h-8 rounded-full px-2.5 text-xs" onClick={() => void run({ type: 'node.setEnabled', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [nodeId], enabled: !data.enabled } })} title={data.enabled ? t('node.tag.disableGroup') : t('node.tag.enableGroup')}>
            <Power className="h-3.5 w-3.5" />{data.enabled ? t('common.on') : t('common.off')}
          </UiChipButton>
          <UiChipButton className="h-8 rounded-full border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-400 hover:bg-red-500/25" onClick={() => void run({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [nodeId] } })} title={t('common.delete')}>
            <Trash2 className="h-3.5 w-3.5" />{t('common.delete')}
          </UiChipButton>
          {error ? <span role="alert" className="max-w-40 truncate px-2 text-[10px] text-red-500" title={error}>{error}</span> : null}
        </UiPanel>
      </ReactFlowNodeToolbar>
      <TagRelationsDialog isOpen={isMembersOpen} nodeId={nodeId} variant="members" onClose={() => setIsMembersOpen(false)} />
    </>
  );
});

TagGroupToolbar.displayName = 'TagGroupToolbar';
