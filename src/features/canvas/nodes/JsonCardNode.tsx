import { memo, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Braces, Expand, LoaderCircle } from 'lucide-react';

import { CANVAS_NODE_TYPES, type JsonCardNodeData } from '@/features/canvas/domain/canvasNodes';
import {
  getValueByJsonPath,
  resolveAiTextResult,
  resolveJsonCardDisplayFields,
  tokenizeJsonPath,
} from '@/features/canvas/application/aiText/helpers';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { TextPreviewModal } from '@/features/canvas/ui/TextPreviewModal';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type JsonCardNodeProps = NodeProps & {
  id: string;
  data: JsonCardNodeData;
  selected?: boolean;
};

type ResolvedDisplayField = {
  path: string;
  label: string;
  value: string;
};

const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1100;
const DEFAULT_STRUCTURED_COLUMN_WIDTH = 220;
const MIN_STRUCTURED_COLUMN_WIDTH = 96;
const MAX_STRUCTURED_COLUMN_WIDTH = 720;

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
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      return value.map((item) => item === null ? '' : String(item)).filter(Boolean).join('\n');
    }
  }
  return safeStringify(value);
}

function createAutoDisplayFields(parsedJson: unknown, limit = 8): ResolvedDisplayField[] {
  if (!isRecord(parsedJson)) {
    return [];
  }

  return Object.entries(parsedJson)
    .filter(([, value]) => value !== undefined)
    .slice(0, limit)
    .map(([key, value]) => ({
      path: `$.${key}`,
      label: key,
      value: formatDisplayValue(value),
    }));
}

type StructuredTableSource = {
  rows: unknown[];
  pathPrefixTokens: string[];
};

type StructuredTableGroup = StructuredTableSource & {
  key: string;
  label: string;
  fields: ResolvedDisplayField[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathFromTokens(tokens: string[]): string {
  return tokens.length > 0 ? `$.${tokens.join('.')}` : '$';
}

function normalizeRowPath(path: string, pathPrefixTokens: string[]): string {
  const tokens = tokenizeJsonPath(path);
  const startsWithPrefix = pathPrefixTokens.length > 0
    && pathPrefixTokens.every((token, index) => tokens[index] === token);
  if (startsWithPrefix) {
    return pathFromTokens(tokens.slice(pathPrefixTokens.length));
  }
  return path.replace(/^\$\[0\](?=\.|\[|$)/, '$');
}

function findArrayPrefixForPath(source: unknown, path: string): StructuredTableSource | null {
  const tokens = tokenizeJsonPath(path);
  let current = source;

  for (let index = 0; index < tokens.length; index += 1) {
    if (!isRecord(current)) {
      return null;
    }
    const next = current[tokens[index]];
    if (Array.isArray(next)) {
      return {
        rows: next,
        pathPrefixTokens: tokens.slice(0, index + 1),
      };
    }
    current = next;
  }

  return null;
}

function resolveStructuredTableGroups(
  parsedJson: unknown,
  fields: ResolvedDisplayField[]
): StructuredTableGroup[] {
  if (Array.isArray(parsedJson)) {
    return [{
      key: '$',
      label: '$',
      fields,
      rows: parsedJson,
      pathPrefixTokens: [],
    }];
  }

  const groups = new Map<string, StructuredTableGroup>();
  fields.forEach((field) => {
    const candidate = findArrayPrefixForPath(parsedJson, field.path);
    if (!candidate || candidate.rows.length === 0) {
      return;
    }
    const key = candidate.pathPrefixTokens.join('\u0000');
    const existing = groups.get(key);
    if (existing) {
      existing.fields.push(field);
      return;
    }
    groups.set(key, {
      key,
      label: pathFromTokens(candidate.pathPrefixTokens),
      fields: [field],
      ...candidate,
    });
  });

  return Array.from(groups.values());
}

function resolveRowValue(row: unknown, path: string, pathPrefixTokens: string[]): string {
  return formatDisplayValue(getValueByJsonPath(row, normalizeRowPath(path, pathPrefixTokens)));
}

function resolveStructuredColumnKey(group: StructuredTableGroup, field: ResolvedDisplayField): string {
  return `${group.key}::${field.path}`;
}

function resolveStructuredColumnWidth(
  widths: Record<string, number> | undefined,
  group: StructuredTableGroup,
  field: ResolvedDisplayField
): number {
  const key = resolveStructuredColumnKey(group, field);
  const width = widths?.[key];
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_STRUCTURED_COLUMN_WIDTH;
  }
  return Math.min(MAX_STRUCTURED_COLUMN_WIDTH, Math.max(MIN_STRUCTURED_COLUMN_WIDTH, Math.round(width)));
}

function resolveStructuredTableWidth(
  widths: Record<string, number>,
  group: StructuredTableGroup
): number {
  return group.fields.reduce(
    (total, field) => total + resolveStructuredColumnWidth(widths, group, field),
    0
  );
}

function resolveGroupedFieldLabel(field: ResolvedDisplayField, pathPrefixTokens: string[]): string {
  const label = field.label.trim();
  const tokens = tokenizeJsonPath(field.path);
  const suffixTokens = tokens
    .slice(pathPrefixTokens.length)
    .filter((token, index) => index > 0 || !/^\d+$/.test(token));
  const suffix = suffixTokens.join('.');

  if (!label || label === field.path || label.startsWith('$.') || label.startsWith('$[')) {
    return suffix || label || field.path;
  }

  return label;
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
  const addNode = useCanvasStore((state) => state.addNode);
  const nodes = useCanvasStore((state) => state.nodes);
  const textAgents = useSettingsStore((state) => state.textAgents);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [columnWidthPreview, setColumnWidthPreview] = useState<Record<string, number>>({});

  const rawResolvedJson = useMemo(() => {
    if (!data.rawContent.trim()) {
      return null;
    }
    const resolved = resolveAiTextResult(data.rawContent);
    return resolved.kind === 'json' ? resolved.parsedJson ?? null : null;
  }, [data.rawContent]);
  const effectiveParsedJson = data.rawContent.trim()
    ? rawResolvedJson
    : data.parsedJson !== null && data.parsedJson !== undefined
    ? data.parsedJson
    : null;
  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.jsonCard, data);
  const resolvedWidth = resolveJsonCardDimension(width, MIN_WIDTH, DEFAULT_WIDTH);
  const resolvedHeight = resolveJsonCardDimension(height, MIN_HEIGHT, DEFAULT_HEIGHT);
  const configuredFields = Array.isArray(data.displayFields) ? data.displayFields : [];
  const sourceAgent = useMemo(
    () => textAgents.find((agent) => agent.id === data.sourceAgentId) ?? null,
    [data.sourceAgentId, textAgents]
  );
  const liveAgentFields = useMemo(
    () => effectiveParsedJson !== null && effectiveParsedJson !== undefined
      ? resolveJsonCardDisplayFields(sourceAgent, effectiveParsedJson)
      : [],
    [effectiveParsedJson, sourceAgent]
  );
  const selectedFields = useMemo(
    () => effectiveParsedJson === null || effectiveParsedJson === undefined
      ? []
      : liveAgentFields.length > 0
      ? liveAgentFields
      : configuredFields.length > 0
      ? configuredFields
      : createAutoDisplayFields(effectiveParsedJson),
    [configuredFields, effectiveParsedJson, liveAgentFields]
  );
  const isStreaming = data.isStreaming === true || data.isGenerating === true;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const liveGenerationElapsedMs = isStreaming && generationStartedAt !== null
    ? Math.max(0, now - generationStartedAt)
    : data.generationElapsedMs;
  const generationElapsedText = formatGenerationElapsedMs(liveGenerationElapsedMs);
  const tableGroups = useMemo(
    () => resolveStructuredTableGroups(effectiveParsedJson, selectedFields),
    [effectiveParsedJson, selectedFields]
  );
  const tableRowCount = tableGroups.reduce((total, group) => total + group.rows.length, 0);
  const tableFieldPaths = useMemo(
    () => new Set(tableGroups.flatMap((group) => group.fields.map((field) => field.path))),
    [tableGroups]
  );
  const fieldBlocks = useMemo(
    () => selectedFields.filter((field) => !tableFieldPaths.has(field.path)),
    [selectedFields, tableFieldPaths]
  );
  const shouldShowStructuredTable = !isStreaming && tableGroups.length > 0;
  const shouldShowStructuredFields = !isStreaming && fieldBlocks.length > 0;
  const structuredColumnWidths = useMemo(
    () => (
      data.structuredColumnWidths
      && typeof data.structuredColumnWidths === 'object'
      && !Array.isArray(data.structuredColumnWidths)
        ? data.structuredColumnWidths
        : {}
    ),
    [data.structuredColumnWidths]
  );
  const effectiveColumnWidths = useMemo(
    () => ({
      ...structuredColumnWidths,
      ...columnWidthPreview,
    }),
    [columnWidthPreview, structuredColumnWidths]
  );
  const prettyJson = useMemo(() => {
    if (effectiveParsedJson !== null && effectiveParsedJson !== undefined) {
      return safeStringify(effectiveParsedJson);
    }
    return data.rawContent || '';
  }, [effectiveParsedJson, data.rawContent]);
  const rawJson = data.rawContent || prettyJson;

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming || !data.rawContent.trim()) {
      return;
    }

    const repairedResult = resolveAiTextResult(data.rawContent);
    if (repairedResult.kind !== 'json' || repairedResult.parsedJson === undefined) {
      return;
    }
    if (!data.parseError && data.parsedJson === repairedResult.parsedJson) {
      return;
    }
    if (
      !data.parseError
      && data.parsedJson !== null
      && data.parsedJson !== undefined
      && JSON.stringify(data.parsedJson) === JSON.stringify(repairedResult.parsedJson)
    ) {
      return;
    }

    updateNodeData(id, {
      rawContent: repairedResult.rawContent || data.rawContent,
      parsedJson: repairedResult.parsedJson,
      parseError: repairedResult.parseError ?? null,
      displayFields: resolveJsonCardDisplayFields(sourceAgent, repairedResult.parsedJson),
    });
  }, [
    data.parseError,
    data.parsedJson,
    data.rawContent,
    data.sourceAgentId,
    id,
    isStreaming,
    sourceAgent,
    updateNodeData,
  ]);

  const createImageNodeFromSelectedText = (selectedText: string) => {
    const sourceNode = nodes.find((node) => node.id === id);
    const sourcePosition = sourceNode?.position ?? { x: 0, y: 0 };
    const sourceWidth =
      sourceNode?.measured?.width
      ?? (typeof sourceNode?.style?.width === 'number' ? sourceNode.style.width : resolvedWidth);
    const newNodeId = addNode(CANVAS_NODE_TYPES.imageEdit, {
      x: sourcePosition.x + sourceWidth + 80,
      y: sourcePosition.y,
    }, {
      prompt: selectedText.trim(),
    });
    setSelectedNode(newNodeId);
  };

  const startColumnResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    group: StructuredTableGroup,
    field: ResolvedDisplayField
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const columnKey = resolveStructuredColumnKey(group, field);
    const startX = event.clientX;
    const startWidth = resolveStructuredColumnWidth(effectiveColumnWidths, group, field);
    let latestWidth = startWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestWidth = Math.min(
        MAX_STRUCTURED_COLUMN_WIDTH,
        Math.max(MIN_STRUCTURED_COLUMN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX))
      );
      setColumnWidthPreview((previous) => ({
        ...previous,
        [columnKey]: latestWidth,
      }));
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      setColumnWidthPreview((previous) => {
        const next = { ...previous };
        delete next[columnKey];
        return next;
      });
      updateNodeData(id, {
        structuredColumnWidths: {
          ...structuredColumnWidths,
          [columnKey]: latestWidth,
        },
      });
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

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
                ) : shouldShowStructuredTable ? `结构化 ${tableRowCount}行` : shouldShowStructuredFields ? '结构化' : '原始'}
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

          {shouldShowStructuredTable || shouldShowStructuredFields ? (
            <div className="flex min-h-0 flex-col gap-4">
              {tableGroups.map((group) => (
                <div key={group.key} className="min-h-0">
                  {tableGroups.length > 1 ? (
                    <div className="mb-2 text-[11px] font-semibold text-text-muted">
                      {group.label} · {group.rows.length}行
                    </div>
                  ) : null}
                  <table
                    className="min-w-full table-fixed border-separate border-spacing-0 text-left text-xs text-text-dark"
                    style={{ width: resolveStructuredTableWidth(effectiveColumnWidths, group) }}
                  >
                    <colgroup>
                      {group.fields.map((field) => (
                        <col
                          key={field.path}
                          style={{ width: resolveStructuredColumnWidth(effectiveColumnWidths, group, field) }}
                        />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-[var(--canvas-node-field-bg)]">
                      <tr>
                        {group.fields.map((field) => (
                          <th
                            key={field.path}
                            className="relative border-b border-[var(--canvas-node-field-border)] px-2 py-2 text-[11px] font-semibold text-text-muted"
                            title={field.path}
                          >
                            <span className="block truncate">
                              {resolveGroupedFieldLabel(field, group.pathPrefixTokens)}
                            </span>
                            <button
                              type="button"
                              data-canvas-no-marquee="true"
                              className="nodrag nowheel absolute bottom-1 right-0 top-1 w-2 cursor-col-resize rounded-sm border-r border-transparent transition-colors hover:border-accent/70 hover:bg-accent/10"
                              title="拖动调整列宽"
                              aria-label="拖动调整列宽"
                              onPointerDown={(event) => startColumnResize(event, group, field)}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="align-top">
                          {group.fields.map((field) => (
                            <td
                              key={`${rowIndex}-${field.path}`}
                              className="border-b border-[var(--canvas-node-field-border)] px-2 py-2 leading-5"
                            >
                              <div className="whitespace-pre-wrap break-words select-text">
                                {resolveRowValue(row, field.path, group.pathPrefixTokens)}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

              {fieldBlocks.length > 0 ? (
                <div className="flex min-h-0 flex-col gap-3">
                  {fieldBlocks.map((field) => (
                    <div
                      key={field.path}
                      className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2.5 py-2"
                    >
                      <div className="shrink-0 truncate text-[11px] text-text-muted">{field.label}</div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-text-dark select-text">
                        {field.value}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
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
        onCreateImageFromSelectedText={createImageNodeFromSelectedText}
      />
    </>
  );
});

JsonCardNode.displayName = 'JsonCardNode';
