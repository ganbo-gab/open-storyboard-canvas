import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Copy, Expand, FileText, PencilLine } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { CANVAS_NODE_TYPES, type TextAnnotationNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { TextPreviewModal } from '@/features/canvas/ui/TextPreviewModal';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { useCanvasStore } from '@/stores/canvasStore';

type TextAnnotationNodeProps = NodeProps & {
  id: string;
  data: TextAnnotationNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 220;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 140;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 1000;

export const TextAnnotationNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: TextAnnotationNodeProps) => {
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditing, setIsEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const content = typeof data.content === 'string' ? data.content : '';
  const isGenerating = data.isGenerating === true;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const liveGenerationElapsedMs = isGenerating && generationStartedAt !== null
    ? Math.max(0, now - generationStartedAt)
    : data.generationElapsedMs;
  const generationElapsedText = formatGenerationElapsedMs(liveGenerationElapsedMs);
  const shouldShowGenerationElapsed = Boolean(
    generationElapsedText && (isGenerating || data.sourceAiNodeId || data.generationElapsedMs !== null)
  );
  const characterCount = useMemo(() => Array.from(content).length, [content]);
  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.textAnnotation, data);
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));
  const previewTitle = useMemo(() => `${resolvedTitle} - 预览`, [resolvedTitle]);

  useEffect(() => {
    if (!selected) {
      setIsEditing(false);
    }
  }, [selected]);

  useEffect(() => {
    if (!isGenerating) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  const handleCopyContent = async () => {
    await navigator.clipboard.writeText(content);
    setCopyFlash(true);
    window.setTimeout(() => setCopyFlash(false), 1200);
  };

  return (
    <>
      <div
        className={`
          group relative h-full w-full overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-2 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
          ${selected
            ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
            : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
        `}
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
      >
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<FileText className="h-4 w-4" />}
          titleText={resolvedTitle}
          rightSlot={(
            <div className="flex items-center gap-1">
              {shouldShowGenerationElapsed ? (
                <span
                  className="rounded-full bg-[rgba(15,23,42,0.72)] px-2 py-[1px] text-[10px] font-medium leading-tight text-white"
                  title="生成耗时"
                >
                  {generationElapsedText}
                </span>
              ) : null}
              <button
                type="button"
                data-canvas-no-marquee="true"
                className={`nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent ${
                  copyFlash ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200' : ''
                }`}
                title={copyFlash ? '已复制' : '复制文本'}
                aria-label={copyFlash ? '已复制' : '复制文本'}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleCopyContent();
                }}
              >
                {copyFlash ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                data-canvas-no-marquee="true"
                className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
                title="编辑"
                aria-label="编辑"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedNode(id);
                  setIsEditing(true);
                }}
              >
                <PencilLine className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-canvas-no-marquee="true"
                className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
                title="放大查看"
                aria-label="放大查看"
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

        {isEditing ? (
          <textarea
            autoFocus
            value={content}
            onChange={(event) => updateNodeData(id, { content: event.target.value })}
            onBlur={() => setIsEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setIsEditing(false);
              }
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                setIsEditing(false);
              }
            }}
            placeholder="输入 Markdown 文本"
            className="nodrag nowheel h-full w-full resize-none border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/70"
          />
        ) : (
          <div
            className="nowheel h-full w-full overflow-auto px-1 py-0.5 text-sm leading-6 text-text-dark"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setSelectedNode(id);
              setIsEditing(true);
            }}
          >
            {content.trim().length > 0 ? (
              <div className="markdown-body select-text break-words [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:border-white/10 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_p+_p]:mt-4 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_td]:border [&_td]:border-white/10 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-white/10 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="pt-1 text-text-muted">暂无内容</div>
            )}
          </div>
        )}

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
          onPointerDownCapture={clearBrowserTextSelection}
          className="!h-2 !w-2 !border-surface-dark !bg-accent"
        />

        <div className="pointer-events-none absolute bottom-1 right-2 z-10 rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] px-1.5 py-0.5 text-[10px] leading-none text-text-muted shadow-sm">
          {characterCount} 字
        </div>
      </div>

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle}
        mode="markdown"
        content={content}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
});

TextAnnotationNode.displayName = 'TextAnnotationNode';
