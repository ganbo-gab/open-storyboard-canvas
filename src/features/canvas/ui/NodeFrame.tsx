import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Handle, NodeResizeControl, Position, ResizeControlVariant, useNodeId, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { AlertTriangle, Ban, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import {
  getNodeDefinition,
  nodeCanStartManualConnection,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { nodeAcceptsManualInput, type ConnectionRejectReason } from '@/features/canvas/application/canvasConnectionRules';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { connectionRejectText } from './connectionRejectText';
import { formatGenerationElapsedMs } from './generationElapsed';
import { anchorBelow } from '@/components/ui/Menu';

export type NodeFrameStatus =
  | { kind: 'generating'; startedAt: number | null; label?: string }
  | { kind: 'error'; label?: string }
  | { kind: 'attention'; label?: string };

export interface NodeFrameResize {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Media nodes keep their aspect; hold Shift to resize freely. */
  keepAspectRatio?: boolean;
}

export interface NodeFrameProps {
  type: CanvasNodeType;
  selected?: boolean;
  icon?: ReactNode;
  title: string;
  /** Double-click the title to rename. Omit to make the title read-only. */
  onRename?: (title: string) => void;
  /** Short, scannable facts, e.g. "16:9 · 2K". */
  meta?: ReactNode;
  status?: NodeFrameStatus | null;
  /** Extra chips beside the title (batch index, duration…). */
  badges?: ReactNode;
  /** Small icon buttons at the right end of the title bar. */
  actions?: ReactNode;
  /** `media`: content fills the card edge to edge. `card`: padded content. `group`: a translucent container. */
  variant?: 'media' | 'card' | 'group';
  tone?: 'default' | 'error' | 'attention';
  /** Omit to fill the box React Flow gives the node (style-sized nodes such as groups). */
  width?: number;
  height?: number;
  resize?: NodeFrameResize | false;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
}

const RESIZE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const FALLBACK_BOX = { width: 320, height: 220 };

/**
 * The box a node renders at: its measured/stored size, else the registry default, never below
 * the resize minimum. Nodes created before a size was stored open at the registry default.
 */
export function resolveNodeBox(
  type: CanvasNodeType,
  width: number | undefined,
  height: number | undefined,
  resize?: NodeFrameResize | false,
): { width: number; height: number } {
  const fallback = getNodeDefinition(type).defaultSize ?? FALLBACK_BOX;
  const min = resize || {};
  return {
    width: Math.max(min.minWidth ?? 0, Math.round(width ?? fallback.width)),
    height: Math.max(min.minHeight ?? 0, Math.round(height ?? fallback.height)),
  };
}

/**
 * The single node shell. Owns everything nodes used to re-implement: the title bar that
 * stays readable at any zoom, ⊕ connection points with a generous hit area, corner resize,
 * selection / error tone, and the live generation timer. Node components render content only.
 */
export const NodeFrame = memo(function NodeFrame({
  type,
  selected = false,
  icon,
  title,
  onRename,
  meta,
  status,
  badges,
  actions,
  variant = 'card',
  tone = 'default',
  width,
  height,
  resize,
  className = '',
  bodyClassName = '',
  bodyStyle,
  children,
}: NodeFrameProps) {
  const resolvedTone = tone !== 'default'
    ? tone
    : status?.kind === 'error'
      ? 'error'
      : status?.kind === 'attention'
        ? 'attention'
        : 'default';
  const nodeId = useNodeId();
  const flow = useReactFlow();
  const { t } = useTranslation();
  // Only the card under a refused connection drag subscribes to a value; every other frame reads null.
  const rejectReason = useCanvasUiStore((state) => (
    nodeId && state.connectionReject?.nodeId === nodeId ? state.connectionReject.reason : null
  ));
  return (
    <div
      className={`node-frame ${className}`}
      data-variant={variant}
      data-tone={resolvedTone}
      data-selected={selected || undefined}
      data-generating={status?.kind === 'generating' || undefined}
      data-connection-reject={rejectReason ? '' : undefined}
      style={{ width: width ?? '100%', height: height ?? '100%' }}
    >
      {rejectReason ? <ConnectionRejectChip reason={rejectReason} /> : null}
      <div className="node-frame__title">
        {icon ? <span className="node-frame__icon">{icon}</span> : null}
        <NodeTitle title={title} onRename={onRename} />
        {meta ? <span className="node-frame__meta">{meta}</span> : null}
        <span className="node-frame__spacer" />
        {badges}
        {status ? <NodeStatusChip status={status} /> : null}
        {actions ? <span className="node-frame__actions">{actions}</span> : null}
        {nodeId && <button type="button" className="nodrag node-frame__more" title={t('rework.canvas.moreActions')} aria-label={t('rework.canvas.moreActions')} aria-haspopup="menu" onClick={(event) => {
          event.stopPropagation();
          const ui = useCanvasUiStore.getState();
          if (ui.contextMenu?.anchor?.trigger === event.currentTarget) { ui.closeMenus(); return; }
          const rect = event.currentTarget.getBoundingClientRect();
          useCanvasStore.getState().setSelectedNode(nodeId);
          useCanvasUiStore.getState().openContextMenu({ nodeId, clientX: rect.right, clientY: rect.bottom + 4, anchor: anchorBelow(event.currentTarget), flowPosition: flow.screenToFlowPosition({ x: rect.right, y: rect.bottom }) });
        }}><MoreHorizontal size={15} /></button>}
      </div>
      <div className={`node-frame__card ${bodyClassName}`} style={bodyStyle}>
        {children}
      </div>
      <NodeHandles type={type} width={width} height={height} />
      {resize === false || !selected ? null : <NodeResizeCorners {...(resize ?? {})} />}
    </div>
  );
});

function ConnectionRejectChip({ reason }: { reason: ConnectionRejectReason }) {
  const { t } = useTranslation();
  return (
    <span className="node-frame__reject" role="status">
      <Ban />
      {connectionRejectText(reason, t)}
    </span>
  );
}

function NodeTitle({ title, onRename }: { title: string; onRename?: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing && onRename) {
    const commit = () => {
      const next = draft.trim();
      if (next && next !== title) onRename(next);
      setEditing(false);
    };
    return (
      <input
        ref={inputRef}
        className="nodrag nopan node-frame__title-input"
        value={draft}
        aria-label={title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className="node-frame__name"
      title={title}
      onDoubleClick={onRename ? (event) => {
        event.stopPropagation();
        setEditing(true);
      } : undefined}
    >
      {title}
    </span>
  );
}

function NodeStatusChip({ status }: { status: NodeFrameStatus }) {
  const { t } = useTranslation();
  if (status.kind === 'generating') {
    return (
      <span className="node-frame__status" data-kind="generating">
        <LoaderCircle className="node-frame__spin" />
        {status.label ?? t('rework.canvas.node.generating')}
        {status.startedAt ? <GenerationTimer startedAt={status.startedAt} /> : null}
      </span>
    );
  }
  return (
    <span className="node-frame__status" data-kind={status.kind}>
      <AlertTriangle />
      {status.label ?? t(status.kind === 'error' ? 'rework.canvas.node.failed' : 'rework.canvas.node.attention')}
    </span>
  );
}

/** Ticks on its own so a running job never re-renders the node body 10×/s. */
export function GenerationTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="node-frame__timer">{formatGenerationElapsedMs(Math.max(0, now - startedAt))}</span>;
}

/** Left = input / reference, right = output. Rendered from the node registry. */
export function NodeHandles({ type, width, height }: { type: CanvasNodeType; width?: number; height?: number }) {
  const canStart = nodeCanStartManualConnection(type);
  const nodeId = useNodeId();
  const updateNodeInternals = useUpdateNodeInternals();
  useLayoutEffect(() => {
    // Flow may retain handle bounds from the previous card size or LOD body.
    // Refresh after this body commits; viewport changes do not retrigger measurement.
    if (!nodeId) return;
    // The initial parent Flow effect installs domNode after child layout effects.
    // Defer the lookup as well as the measurement so a first mount is included.
    const frame = requestAnimationFrame(() => updateNodeInternals(nodeId));
    return () => cancelAnimationFrame(frame);
  }, [height, nodeId, type, updateNodeInternals, width]);
  return (
    <>
      {nodeHasTargetHandle(type) ? (
        // Material/result cards keep the handle for internal result edges but refuse manual input.
        <Handle
          type="target"
          id="target"
          position={Position.Left}
          className="node-handle"
          isConnectableStart={nodeAcceptsManualInput(type)}
          isConnectableEnd={nodeAcceptsManualInput(type)}
          data-passive={nodeAcceptsManualInput(type) ? undefined : 'true'}
          onPointerDownCapture={clearBrowserTextSelection}
        >
          {nodeAcceptsManualInput(type) ? <span className="node-handle__dot"><Plus /></span> : null}
        </Handle>
      ) : null}
      {nodeHasSourceHandle(type) ? (
        <Handle
          type="source"
          id="source"
          position={Position.Right}
          className="node-handle"
          data-passive={canStart ? undefined : 'true'}
          isConnectableStart={canStart}
          isConnectableEnd={canStart}
          // Dragging out of a node with selected text would otherwise drag the text.
          onPointerDownCapture={clearBrowserTextSelection}
        >
          {canStart ? <span className="node-handle__dot"><Plus /></span> : null}
        </Handle>
      ) : null}
    </>
  );
}

function NodeResizeCorners({
  minWidth = 160,
  minHeight = 100,
  maxWidth = 2400,
  maxHeight = 2400,
  keepAspectRatio = false,
}: NodeFrameResize) {
  const shiftHeld = useShiftHeld(keepAspectRatio);
  return (
    <>
      {RESIZE_CORNERS.map((corner) => (
        <NodeResizeControl
          key={corner}
          position={corner}
          variant={ResizeControlVariant.Handle}
          autoScale={false}
          minWidth={minWidth}
          minHeight={minHeight}
          maxWidth={maxWidth}
          maxHeight={maxHeight}
          keepAspectRatio={keepAspectRatio && !shiftHeld}
          className="node-resize"
          data-corner={corner}
        />
      ))}
    </>
  );
}

function useShiftHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = (event: KeyboardEvent) => setHeld(event.shiftKey);
    const reset = () => setHeld(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', reset);
    };
  }, [enabled]);
  return held;
}
