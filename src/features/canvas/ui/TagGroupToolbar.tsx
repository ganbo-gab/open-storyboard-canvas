import { memo, useEffect, useState } from 'react';
import { SafeNodeToolbar } from './SafeNodeToolbar';
import { Eye, Frame, Power, RectangleHorizontal, Scan, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiChipButton, UiIconButton, UiInput, UiPanel } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  TAG_COLORS,
  type TagColor,
  type TagGroupNodeData,
  type TagGroupShape,
} from '@/features/canvas/domain/canvasNodes';
import { TagRelationsDialog } from '@/features/canvas/nodes/TagRelationsDialog';

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
      <SafeNodeToolbar nodeId={nodeId} offset={25} className="pointer-events-auto">
        <UiPanel className="flex max-w-[760px] items-center gap-1 rounded-full p-1 shadow-xl">
          <UiInput
            value={name}
            aria-label={t('node.tag.groupName')}
            className="nodrag h-8 w-32 rounded-full px-3 text-xs"
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          <div className="flex items-center gap-0.5 px-1" aria-label={t('node.tag.colorLabel')}>
            {TAG_COLORS.map((color) => (
              <UiIconButton variant="ghost"
                key={color}
                type="button"
                className={`h-5 w-5 min-w-0 rounded-full border-2 p-0 transition-transform hover:scale-110 ${data.color === color ? 'border-text-dark' : 'border-transparent'}`}
                style={{ backgroundColor: COLOR_VARIABLES[color] }}
                aria-label={t(`node.tag.colors.${color}`)}
                onClick={() => void run({ type: 'tagGroup.setAppearance', version: CANVAS_COMMAND_VERSION, input: { groupId: nodeId, color } })}
              />
            ))}
          </div>
          <div className="flex items-center gap-0.5 border-l border-(--canvas-node-divider) pl-1">
            {SHAPES.map(({ value, icon: Icon }) => (
              <UiIconButton variant="ghost"
                key={value}
                type="button"
                className="h-7 w-7 rounded-full"
                active={data.shape === value}
                aria-label={t(`node.tag.shapes.${value}`)}
                title={t(`node.tag.shapes.${value}`)}
                onClick={() => void run({ type: 'tagGroup.setAppearance', version: CANVAS_COMMAND_VERSION, input: { groupId: nodeId, shape: value } })}
              ><Icon className="h-3.5 w-3.5" /></UiIconButton>
            ))}
          </div>
          <UiChipButton className="h-8 rounded-full px-2.5 text-xs" onClick={() => setIsMembersOpen(true)} title={t('node.tag.viewMembers')}>
            <Eye className="h-3.5 w-3.5" />{t('node.tag.view')}
          </UiChipButton>
          <UiChipButton className="h-8 rounded-full px-2.5 text-xs" onClick={() => void run({ type: 'node.setEnabled', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [nodeId], enabled: !data.enabled } })} title={data.enabled ? t('node.tag.disableGroup') : t('node.tag.enableGroup')}>
            <Power className="h-3.5 w-3.5" />{data.enabled ? t('common.on') : t('common.off')}
          </UiChipButton>
          <UiChipButton className="h-8 rounded-full border-danger/45 bg-danger/15 px-2.5 text-xs text-danger hover:bg-danger/25" onClick={() => void run({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [nodeId] } })} title={t('common.delete')}>
            <Trash2 className="h-3.5 w-3.5" />{t('common.delete')}
          </UiChipButton>
          {error ? <span role="alert" className="max-w-40 truncate px-2 text-[10px] text-danger" title={error}>{error}</span> : null}
        </UiPanel>
      </SafeNodeToolbar>
      <TagRelationsDialog isOpen={isMembersOpen} nodeId={nodeId} variant="members" onClose={() => setIsMembersOpen(false)} />
    </>
  );
});

TagGroupToolbar.displayName = 'TagGroupToolbar';
