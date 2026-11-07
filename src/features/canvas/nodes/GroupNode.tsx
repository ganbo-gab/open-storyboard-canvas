import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { LayoutGrid } from 'lucide-react';

import { CANVAS_NODE_TYPES, type GroupNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';

type GroupNodeProps = NodeProps & { data: GroupNodeData };

const RESIZE = { minWidth: 220, minHeight: 140, maxWidth: 4000, maxHeight: 4000 } as const;

/** Container for a set of nodes; sized by React Flow (style), so the frame fills its box. */
export const GroupNode = memo(({ id, data, selected = false }: GroupNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  return (
    <NodeFrame
      type={CANVAS_NODE_TYPES.group}
      selected={selected}
      icon={<LayoutGrid />}
      title={resolveNodeDisplayName(CANVAS_NODE_TYPES.group, data)}
      onRename={(name) => updateNodeData(id, { displayName: name, label: name })}
      variant="group"
      resize={RESIZE}
    />
  );
});

GroupNode.displayName = 'GroupNode';
