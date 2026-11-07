import { memo, useEffect, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Check, Copy, Expand, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { CANVAS_NODE_TYPES, type TextAnnotationNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
import { TextPreviewModal } from '@/features/canvas/ui/TextPreviewModal';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePromptDraft } from '@/features/canvas/composer/usePromptDraft';

type TextAnnotationNodeProps = NodeProps & {
  id: string;
  data: TextAnnotationNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 220;
const RESIZE = { minWidth: 220, minHeight: 140, maxWidth: 1000, maxHeight: 1000 } as const;

/** Markdown note / prompt fragment. Double-click (or Enter on the selected node) edits in place. */
export const TextAnnotationNode = memo(({ id, data, selected = false, width, height }: TextAnnotationNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditing, setIsEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const content = typeof data.content === 'string' ? data.content : '';
  const draft = usePromptDraft(id, 'content', content);
  const isGenerating = data.isGenerating === true;
  const startedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const title = resolveNodeDisplayName(CANVAS_NODE_TYPES.textAnnotation, data);
  const finishedElapsed = !isGenerating && data.sourceAiNodeId ? formatGenerationElapsedMs(data.generationElapsedMs) : '';

  useEffect(() => {
    if (!selected) {
      draft.flush();
      setIsEditing(false);
    }
  }, [selected]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.textAnnotation}
        selected={selected}
        icon={<FileText />}
        title={title}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={t('rework.canvas.node.chars', { count: Array.from(content).length })}
        status={isGenerating ? { kind: 'generating', startedAt } : null}
        badges={finishedElapsed ? <span className="node-frame__badge" title={t('rework.canvas.node.elapsed')}>{finishedElapsed}</span> : null}
        actions={(
          <>
            <button
              type="button"
              className="nodrag"
              aria-label={copied ? t('rework.canvas.node.copied') : t('rework.canvas.node.copy')}
              title={copied ? t('rework.canvas.node.copied') : t('rework.canvas.node.copy')}
              disabled={!content}
              onClick={(event) => {
                event.stopPropagation();
                void navigator.clipboard.writeText(content).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <Copy />}
            </button>
            <button
              type="button"
              className="nodrag"
              aria-label={t('rework.canvas.node.expand')}
              title={t('rework.canvas.node.expand')}
              onClick={(event) => {
                event.stopPropagation();
                setPreviewOpen(true);
              }}
            >
              <Expand />
            </button>
          </>
        )}
        width={Math.max(RESIZE.minWidth, Math.round(width ?? DEFAULT_WIDTH))}
        height={Math.max(RESIZE.minHeight, Math.round(height ?? DEFAULT_HEIGHT))}
        resize={RESIZE}
        bodyClassName="node-text"
      >
        {isEditing ? (
          <textarea
            autoFocus
            value={draft.value}
            placeholder={t('rework.canvas.node.placeholder')}
            className="nodrag nowheel node-text__editor"
            onChange={(event) => draft.set(event.target.value)}
            onBlur={() => {
              draft.flush();
              setIsEditing(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
                event.preventDefault();
                draft.flush();
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <div
            className="nowheel node-text__view"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setIsEditing(true);
            }}
          >
            {content.trim() ? (
              <div className="node-markdown select-text">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
              </div>
            ) : (
              <p className="node-text__empty">{t('rework.canvas.node.empty')}</p>
            )}
          </div>
        )}
      </NodeFrame>
      <TextPreviewModal
        open={previewOpen}
        title={t('rework.canvas.node.preview', { title })}
        mode="markdown"
        content={content}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
});

TextAnnotationNode.displayName = 'TextAnnotationNode';
