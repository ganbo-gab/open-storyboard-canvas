import { memo, useMemo, useRef, useState, useEffect } from 'react';
import { Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
  useReactFlow,
} from '@xyflow/react';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  EMPTY_CANVAS_GEOMETRY_INDEX,
  getSharedCanvasGeometryIndex,
  getSharedCanvasNodeIndex,
} from '@/features/canvas/application/canvasGraphIndex';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';

export const DisconnectableEdge = memo(function DisconnectableEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    selected,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  } = props;
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const { t } = useTranslation();
  const { screenToFlowPosition } = useReactFlow();
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  const geometryIndex = useCanvasStore((state) => (
    canvasEdgeRoutingMode === 'smartOrthogonal'
      ? getSharedCanvasGeometryIndex(state.nodes)
      : EMPTY_CANVAS_GEOMETRY_INDEX
  ));
  const isProcessingEdge = useCanvasStore((state) => {
    const nodeIndex = getSharedCanvasNodeIndex(state.nodes);
    const sourceNode = nodeIndex.get(source);
    const targetNode = nodeIndex.get(target);

    if (!sourceNode || !targetNode || targetNode.type !== CANVAS_NODE_TYPES.exportImage) {
      return false;
    }

    const isSupportedSource =
      sourceNode.type === CANVAS_NODE_TYPES.storyboardGen ||
      sourceNode.type === CANVAS_NODE_TYPES.imageEdit;
    if (!isSupportedSource) {
      return false;
    }

    return (targetNode.data as { isGenerating?: boolean } | undefined)?.isGenerating === true;
  });

  const { edgePath, labelX, labelY } = useMemo(() => {
    if (canvasEdgeRoutingMode === 'spline') {
      const [path, nextLabelX, nextLabelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      return {
        edgePath: path,
        labelX: nextLabelX,
        labelY: nextLabelY,
      };
    }

    const route = buildOrthogonalRoute({
      sourceId: source,
      targetId: target,
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Right,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Left,
      geometryIndex,
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return {
      edgePath: route.path,
      labelX: route.labelX,
      labelY: route.labelY,
    };
  }, [
    canvasEdgeRoutingMode,
    geometryIndex,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={isProcessingEdge ? 'canvas-edge__base is-processing' : 'canvas-edge__base'}
        style={style}
      />
      {/* Flowing highlight: always on while the target is generating, otherwise on hover/selection. */}
      <path
        d={edgePath}
        fill="none"
        className={isProcessingEdge ? 'canvas-edge__flow is-active' : 'canvas-edge__flow'}
        style={{ pointerEvents: 'none' }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        className="canvas-edge__hit"
        style={{ pointerEvents: 'stroke' }}
        onPointerMove={(event) => {
          window.clearTimeout(leaveTimer.current);
          // Scissors follow the pointer's projection on the curve, not a fixed midpoint.
          const pointer = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const path = event.currentTarget;
          const length = path.getTotalLength();
          let closest = { x: labelX, y: labelY };
          let distance = Infinity;
          for (let index = 0; index <= 48; index++) {
            const point = path.getPointAtLength(length * index / 48);
            const nextDistance = (point.x - pointer.x) ** 2 + (point.y - pointer.y) ** 2;
            if (nextDistance < distance) { closest = { x: point.x, y: point.y }; distance = nextDistance; }
          }
          setHoverPoint(closest);
        }}
        onPointerLeave={() => { leaveTimer.current = window.setTimeout(() => setHoverPoint(null), 160); }}
      />
      {(selected || hoverPoint) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan canvas-edge__cut"
            style={{ transform: `translate(-50%, -50%) translate(${hoverPoint?.x ?? labelX}px, ${hoverPoint?.y ?? labelY}px) scale(var(--canvas-ui-scale, 1))` }}
            onPointerEnter={() => window.clearTimeout(leaveTimer.current)}
            onPointerLeave={() => setHoverPoint(null)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); deleteEdge(id); }}
            title={t('rework.canvas.disconnect')}
            aria-label={t('rework.canvas.disconnect')}
          >
            <Scissors className="h-3.5 w-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
