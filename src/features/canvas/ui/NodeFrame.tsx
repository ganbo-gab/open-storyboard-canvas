import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Handle, NodeResizeControl, Position, ResizeControlVariant } from '@xyflow/react';
import { AlertTriangle, LoaderCircle, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import {
  nodeCanStartManualConnection,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { formatGenerationElapsedMs } from './generationElapsed';

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
  /** `media`: content fills the card edge to edge. `card`: padded content. */
  variant?: 'media' | 'card';
  tone?: 'default' | 'error' | 'attention';
  width: number;
  height: number;
  resize?: NodeFrameResize | false;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
}

const RESIZE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

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
  return (
    <div
      className={`node-frame ${className}`}
      data-variant={variant}
      data-tone={resolvedTone}
      data-selected={selected || undefined}
      data-generating={status?.kind === 'generating' || undefined}
      style={{ width, height }}
    >
      <div className="node-frame__title">
        {icon ? <span className="node-frame__icon">{icon}</span> : null}
        <NodeTitle title={title} onRename={onRename} />
        {meta ? <span className="node-frame__meta">{meta}</span> : null}
        <span className="node-frame__spacer" />
        {badges}
        {status ? <NodeStatusChip status={status} /> : null}
        {actions ? <span className="node-frame__actions">{actions}</span> : null}
      </div>
      <div className={`node-frame__card ${bodyClassName}`} style={bodyStyle}>
        {children}
      </div>
      <NodeHandles type={type} />
      {resize === false || !selected ? null : <NodeResizeCorners {...(resize ?? {})} />}
    </div>
  );
});

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
export function NodeHandles({ type }: { type: CanvasNodeType }) {
  const canStart = nodeCanStartManualConnection(type);
  return (
    <>
      {nodeHasTargetHandle(type) ? (
        <Handle type="target" id="target" position={Position.Left} className="node-handle" isConnectableStart={false}>
          <span className="node-handle__dot"><Plus /></span>
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
