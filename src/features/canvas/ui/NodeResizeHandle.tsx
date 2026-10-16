import { NodeResizeControl } from '@xyflow/react';

type NodeResizeHandleProps = {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

const DEFAULT_MIN_WIDTH = 160;
const DEFAULT_MIN_HEIGHT = 100;
const DEFAULT_MAX_WIDTH = 1400;
const DEFAULT_MAX_HEIGHT = 1400;

export function NodeResizeHandle({
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: NodeResizeHandleProps) {
  return (
    <NodeResizeControl
      minWidth={minWidth}
      minHeight={minHeight}
      maxWidth={maxWidth}
      maxHeight={maxHeight}
      position="bottom-right"
      className="h-5! w-5! min-h-0! min-w-0! rounded-none! border-0! bg-transparent! p-0! opacity-0! transition-opacity duration-100 hover:opacity-100! focus-within:opacity-100!"
    >
      <div className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b border-r border-white/35 transition-colors hover:border-accent" />
    </NodeResizeControl>
  );
}
