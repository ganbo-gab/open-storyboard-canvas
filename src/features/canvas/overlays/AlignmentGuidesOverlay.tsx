import { ViewportPortal, useStore, type ReactFlowState } from '@xyflow/react';

import type { AlignmentGuides } from '@/features/canvas/engine/alignment';
import { useCanvasAlignmentStore } from '@/features/canvas/state/canvasUiStore';
import { resolveGuideSpanEnd, resolveGuideSpanStart } from './alignmentGuideSpan';

// Primitive selectors: they only change when a phase-aligned endpoint moves, so sub-period pans skip rendering.
const selectColumnStart = (state: ReactFlowState) => resolveGuideSpanStart(state.transform[1], state.transform[2], state.height);
const selectColumnEnd = (state: ReactFlowState) => resolveGuideSpanEnd(state.transform[1], state.transform[2], state.height);
const selectRowStart = (state: ReactFlowState) => resolveGuideSpanStart(state.transform[0], state.transform[2], state.width);
const selectRowEnd = (state: ReactFlowState) => resolveGuideSpanEnd(state.transform[0], state.transform[2], state.width);

/** Mounted only while guides exist, so idle canvases hold no viewport subscription. */
function AlignmentGuideLines({ guides }: { guides: AlignmentGuides }) {
  const columnStart = useStore(selectColumnStart);
  const columnEnd = useStore(selectColumnEnd);
  const rowStart = useStore(selectRowStart);
  const rowEnd = useStore(selectRowEnd);
  return (
    <ViewportPortal>
      <svg className="canvas-alignment-guides" width={1} height={1} aria-hidden="true">
        {columnStart < columnEnd && guides.x.map((x) => (
          <line key={`x${x}`} x1={x} x2={x} y1={columnStart} y2={columnEnd} />
        ))}
        {rowStart < rowEnd && guides.y.map((y) => (
          <line key={`y${y}`} y1={y} y2={y} x1={rowStart} x2={rowEnd} />
        ))}
      </svg>
    </ViewportPortal>
  );
}

/** Snap guides published by the drag engine (flow coordinates); renders nothing between drags. */
export function AlignmentGuidesOverlay() {
  const guides = useCanvasAlignmentStore((state) => state.alignmentGuides);
  if (!guides || (!guides.x.length && !guides.y.length)) return null;
  return <AlignmentGuideLines guides={guides} />;
}
