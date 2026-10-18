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

  const processingStroke = 'rgb(var(--accent-rgb) / 0.94)';
  const processingDashStroke = 'rgb(var(--accent-rgb) / 1)';
  const baseStrokeWidth = isProcessingEdge
    ? (selected ? 2.7 : 2.2)
    : (selected ? 2.4 : 1.9);

  return (
    <>
      {isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={processingDashStroke}
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="canvas-processing-edge__flow"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isProcessingEdge ? processingStroke : style?.stroke,
          strokeWidth: baseStrokeWidth,
          ...style,
        }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        className="canvas-edge-hit"
        style={{ pointerEvents: 'stroke' }}
        onPointerMove={(event) => {
          window.clearTimeout(leaveTimer.current);
          const pointer = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const path = event.currentTarget;
          const length = path.getTotalLength();
          let closest = { x: labelX, y: labelY };
          let distance = Infinity;
          for (let index = 0; index <= 32; index++) {
            const point = path.getPointAtLength(length * index / 32);
            const nextDistance = (point.x - pointer.x) ** 2 + (point.y - pointer.y) ** 2;
            if (nextDistance < distance) { closest = { x: point.x, y: point.y }; distance = nextDistance; }
          }
          setHoverPoint(closest);
        }}
        onPointerLeave={() => { leaveTimer.current = window.setTimeout(() => setHoverPoint(null), 180); }}
      />
      {(selected || hoverPoint) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan canvas-edge-disconnect absolute flex h-8 w-8 items-center justify-center rounded-full border border-border-dark bg-surface-dark text-text-muted shadow-lg transition-colors hover:border-red-400/50 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-accent"
            style={{ transform: `translate(-50%, -50%) translate(${hoverPoint?.x ?? labelX}px, ${hoverPoint?.y ?? labelY}px)`, pointerEvents: 'all' }}
            onPointerEnter={() => window.clearTimeout(leaveTimer.current)}
            onPointerLeave={() => setHoverPoint(null)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); deleteEdge(id); }}
            title={t('rework.canvas.disconnect')}
            aria-label={t('rework.canvas.disconnect')}
          >
            <Scissors className="h-4 w-4" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
