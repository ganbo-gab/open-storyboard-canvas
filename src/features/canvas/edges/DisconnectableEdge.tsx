import { memo, useMemo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';

const EMPTY_ROUTE_NODES: CanvasNode[] = [];

function resolveNodeWidth(node: CanvasNode): number | string {
  return node.measured?.width
    ?? node.width
    ?? (typeof node.style?.width === 'number' || typeof node.style?.width === 'string' ? node.style.width : '');
}

function resolveNodeHeight(node: CanvasNode): number | string {
  return node.measured?.height
    ?? node.height
    ?? (typeof node.style?.height === 'number' || typeof node.style?.height === 'string' ? node.style.height : '');
}

function buildNodeGeometrySignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => [
      node.id,
      node.type,
      node.position.x,
      node.position.y,
      resolveNodeWidth(node),
      resolveNodeHeight(node),
    ].join(':'))
    .join('|');
}

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
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  const nodeGeometrySignature = useCanvasStore((state) =>
    canvasEdgeRoutingMode === 'smartOrthogonal' ? buildNodeGeometrySignature(state.nodes) : ''
  );
  const routeNodes = useMemo(
    () => (canvasEdgeRoutingMode === 'smartOrthogonal' ? useCanvasStore.getState().nodes : EMPTY_ROUTE_NODES),
    [canvasEdgeRoutingMode, nodeGeometrySignature]
  );
  const isProcessingEdge = useCanvasStore((state) => {
    const sourceNode = state.nodes.find((node) => node.id === source);
    const targetNode = state.nodes.find((node) => node.id === target);

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
      nodes: routeNodes,
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return {
      edgePath: route.path,
      labelX: route.labelX,
      labelY: route.labelY,
    };
  }, [
    canvasEdgeRoutingMode,
    routeNodes,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  // 🎨 光效连线样式
  const baseStrokeWidth = isProcessingEdge
    ? (selected ? 3 : 2.5)
    : (selected ? 2.5 : 2);
  
  const glowColor = selected 
    ? 'rgba(139, 92, 246, 0.6)' 
    : 'rgba(59, 130, 246, 0.4)';
  
  const processingStroke = 'rgb(var(--accent-rgb) / 0.94)';
  const processingDashStroke = 'rgb(var(--accent-rgb) / 1)';

  return (
    <>
      {/* 🌟 外层光晕 */}
      {!isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={glowColor}
          strokeWidth={baseStrokeWidth + 6}
          strokeLinecap="round"
          className="canvas-edge-glow"
          style={{ 
            pointerEvents: 'none',
            filter: 'blur(8px)',
            opacity: selected ? 0.7 : 0.5,
          }}
        />
      )}
      
      {/* 🌟 中间渐变层 */}
      {!isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke="url(#edge-gradient)"
          strokeWidth={baseStrokeWidth + 2}
          strokeLinecap="round"
          style={{ pointerEvents: 'none' }}
        />
      )}
      
      {/* 🌟 处理中虚线光效 */}
      {isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={processingDashStroke}
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="canvas-processing-edge__flow"
          style={{ 
            pointerEvents: 'none',
            filter: 'drop-shadow(0 0 6px rgba(59, 130, 246, 0.8))',
          }}
        />
      )}
      
      {/* 🌟 核心实线 */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isProcessingEdge ? processingStroke : (selected ? '#a78bfa' : '#60a5fa'),
          strokeWidth: baseStrokeWidth,
          filter: isProcessingEdge ? undefined : 'drop-shadow(0 0 4px rgba(96, 165, 250, 0.6))',
          ...style,
        }}
      />
      
      {/* 🌟 SVG 渐变定义（只添加一次） */}
      <defs>
        <linearGradient id="edge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(139, 92, 246, 0.9)" />
          <stop offset="50%" stopColor="rgba(59, 130, 246, 0.95)" />
          <stop offset="100%" stopColor="rgba(236, 72, 153, 0.9)" />
        </linearGradient>
      </defs>
      
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan absolute flex h-6 w-6 items-center justify-center text-text-muted transition-colors hover:text-text-dark dark:hover:text-text-light"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onClick={(event) => {
              event.stopPropagation();
              deleteEdge(id);
            }}
            aria-label="断开连线"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M2 12C2 6.477 6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12m7.707-3.707a1 1 0 0 0-1.414 1.414L10.586 12l-2.293 2.293a1 1 0 1 0 1.414 1.414L12 13.414l2.293 2.293a1 1 0 0 0 1.414-1.414L13.414 12l2.293-2.293a1 1 0 0 0-1.414-1.414L12 10.586z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
