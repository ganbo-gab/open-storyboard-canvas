import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Braces, Expand, LoaderCircle } from 'lucide-react';

import { CANVAS_NODE_TYPES, type JsonCardNodeData } from '@/features/canvas/domain/canvasNodes';
import { getValueByJsonPath } from '@/features/canvas/application/aiText/helpers';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { TextPreviewModal } from '@/features/canvas/ui/TextPreviewModal';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { useCanvasStore } from '@/stores/canvasStore';

type JsonCardNodeProps = NodeProps & {
  id: string;
  data: JsonCardNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1100;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return safeStringify(value);
}

function normalizeRowPath(path: string): string {
  return path.replace(/^\$\[0\](?=\.|\[|$)/, '$');
}

function resolveRowValue(row: unknown, path: string): string {
  return formatDisplayValue(getValueByJsonPath(row, normalizeRowPath(path)));
}

function resolveJsonCardDimension(value: number | undefined, min: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= min) {
    return fallback;
  }
  return Math.round(value);
}

export const JsonCardNode = memo(({ id, data, selected, width, height }: JsonCardNodeProps) => {
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.jsonCard, data);
  const resolvedWidth = resolveJsonCardDimension(width, MIN_WIDTH, DEFAULT_WIDTH);
  const resolvedHeight = resolveJsonCardDimension(height, MIN_HEIGHT, DEFAULT_HEIGHT);
  const selectedFields = Array.isArray(data.displayFields) ? data.displayFields : [];
  const isStreaming = data.isStreaming === true || data.isGenerating === true;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const liveGenerationElapsedMs = isStreaming && generationStartedAt !== null
    ? Math.max(0, now - generationStartedAt)
    : data.generationElapsedMs;
  const generationElapsedText = formatGenerationElapsedMs(liveGenerationElapsedMs);
  const tableRows = useMemo(
    () => Array.isArray(data.parsedJson) ? data.parsedJson : [],
    [data.parsedJson]
  );
  const shouldShowStructuredTable = !isStreaming && tableRows.length > 0 && selectedFields.length > 0;
  const prettyJson = useMemo(() => {
    if (data.parsedJson !== null && data.parsedJson !== undefined) {
      return safeStringify(data.parsedJson);
    }
    return data.rawContent || '';
  }, [data.parsedJson, data.rawContent]);
  const rawJson = data.rawContent || prettyJson;

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  return (
    <>
      <div
        className={`
          group relative flex h-full w-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-2 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
          ${selected
            ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
            : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
        `}
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
      >
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Braces className="h-4 w-4" />}
          titleText={resolvedTitle}
          rightSlot={(
            <div className="flex items-center gap-1.5">
              {generationElapsedText ? (
                <span
                  className="rounded-full bg-[rgba(15,23,42,0.72)] px-2 py-[1px] text-[10px] font-medium leading-tight text-white"
                  title="生成耗时"
                >
                  {generationElapsedText}
                </span>
              ) : null}
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] px-2 text-[10px] text-text-muted">
                {isStreaming ? (
                  <>
                    <LoaderCircle className="h-3 w-3 animate-spin text-accent" />
                    流式
                  </>
                ) : shouldShowStructuredTable ? '结构化' : '原始'}
              </span>
              <button
                type="button"
                data-canvas-no-marquee="true"
                className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
                title="放大查看源 JSON"
                aria-label="放大查看源 JSON"
                onClick={(event) => {
                  event.stopPropagation();
                  setPreviewOpen(true);
                }}
              >
                <Expand className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          editable
          onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
        />

        <NodeResizeHandle
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          maxWidth={MAX_WIDTH}
          maxHeight={MAX_HEIGHT}
        />

        <div
          className="ui-scrollbar nodrag nowheel min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-3"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {data.parseError && !isStreaming ? (
            <div className="mb-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
              JSON 解析失败: {data.parseError}
            </div>
          ) : null}

          {shouldShowStructuredTable ? (
            <table className="w-full table-fixed border-separate border-spacing-0 text-left text-xs text-text-dark">
              <thead className="sticky top-0 z-10 bg-[var(--canvas-node-field-bg)]">
                <tr>
                  {selectedFields.map((field) => (
                    <th
                      key={field.path}
                      className="border-b border-[var(--canvas-node-field-border)] px-2 py-2 text-[11px] font-semibold text-text-muted"
                    >
                      <span className="block truncate">{field.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="align-top">
                    {selectedFields.map((field) => (
                      <td
                        key={`${rowIndex}-${field.path}`}
                        className="border-b border-[var(--canvas-node-field-border)] px-2 py-2 leading-5"
                      >
                        <div className="max-h-36 overflow-hidden whitespace-pre-wrap break-words select-text">
                          {resolveRowValue(row, field.path)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !isStreaming && selectedFields.length > 0 ? (
            <div className="grid grid-cols-1 gap-2">
              {selectedFields.slice(0, 4).map((field) => (
                <div
                  key={field.path}
                  className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 py-1.5"
                >
                  <div className="truncate text-[11px] text-text-muted">{field.label}</div>
                  <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-text-dark select-text">
                    {field.value}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words select-text font-mono text-xs leading-6 text-text-dark">
              {rawJson || '暂无内容'}
            </pre>
          )}
        </div>

        <Handle
          type="target"
          id="target"
          position={Position.Left}
          className="!h-2 !w-2 !border-surface-dark !bg-accent"
        />
        <Handle
          type="source"
          id="source"
          position={Position.Right}
          className="!h-2 !w-2 !border-surface-dark !bg-accent"
        />
      </div>

      <TextPreviewModal
        open={previewOpen}
        title={`${resolvedTitle} - 源 JSON`}
        mode="json"
        content={rawJson}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
});

JsonCardNode.displayName = 'JsonCardNode';
