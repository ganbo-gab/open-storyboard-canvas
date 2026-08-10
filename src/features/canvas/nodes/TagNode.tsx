import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizeControl, NodeToolbar, Position } from '@xyflow/react';
import { Link2, Tag, Trash2 } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { UiChipButton, UiPanel } from '@/components/ui';
import { BatchConnectModal } from '@/features/canvas/ui/BatchConnectModal';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from '@/features/canvas/ui/nodeToolbarConfig';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';

/**
 * 🎨 配色规则：颜色由「连接的源节点」决定——
 * 连接相同的源节点才会同色；只有相同源节点才允许相同颜色。
 * 未连接任何源（新建标签）时，退化为按标签文字计算，保证不同内容可区分。
 * 用两个互相独立的哈希（一个算色相，一个算饱和度/明度）来尽量拉开色彩差异，
 * 减少不同内容撞到相近颜色的概率。
 */
function hashString(str: string, salt = ''): number {
  const input = str + salt;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((ch) => `${ch}${ch}`)
          .join('')
      : normalized;

  const value = parseInt(full, 16);
  if (Number.isNaN(value)) {
    return `rgba(59, 130, 246, ${alpha})`;
  }

  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface TagPalette {
  border: string;
  text: string;
  dot: string;
  ring: string;
}

export function resolveTagColorKey(name: string, sourceId: string | null): string {
  if (sourceId) return `src:${sourceId}`;
  return `text:${(name || '').trim()}`;
}

/**
 * ✅ 双主题调色板：
 * - 浅色模式：白底胶囊，文字用低明度（26–44%）
 * - 深色模式：深灰胶囊，文字/图标必须用高明度（70%+）才能清晰可读
 * 色相始终由内容哈希决定，同色规则不受主题影响。
 */
function getTagPalette(colorKey: string, isDark: boolean): TagPalette {
  const hueHash = hashString(colorKey, '#hue');
  const toneHash = hashString(colorKey, '#tone');
  const hue = hueHash % 360;
  const sat = 55 + (toneHash % 25); // 55–80%
  const light = 40 + ((toneHash >> 8) % 14); // 40–54%

  if (isDark) {
    const textLight = 70 + ((toneHash >> 8) % 8); // 70–77%
    return {
      border: `hsl(${hue}, ${sat}%, ${Math.min(light + 14, 66)}%)`,
      text: `hsl(${hue}, ${Math.min(sat + 5, 85)}%, ${textLight}%)`,
      dot: `hsl(${hue}, ${sat}%, ${Math.min(light + 12, 62)}%)`,
      ring: `hsla(${hue}, ${sat}%, ${Math.min(light + 12, 62)}%, 0.3)`,
    };
  }

  return {
    border: `hsl(${hue}, ${sat}%, ${light}%)`,
    text: `hsl(${hue}, ${Math.min(sat + 10, 92)}%, ${Math.max(light - 10, 26)}%)`,
    dot: `hsl(${hue}, ${sat}%, ${Math.max(light - 4, 30)}%)`,
    ring: `hsla(${hue}, ${sat}%, ${light}%, 0.3)`,
  };
}

function buildEdgeItem(source: string, target: string) {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'disconnectableEdge',
  };
}

export const TagNode = memo((props: any) => {
  const { id, data, selected, width, height } = props;
  const name = data?.displayName || data?.label || '新标签';
  const sourceId = (data?.sourceId as string | null) || null;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [isBatchConnectOpen, setIsBatchConnectOpen] = useState(false);

  // ✅ 新增：订阅主题，深色模式下抬升文字/图标明度
  const isDark = useThemeStore((s) => s.theme) === 'dark';

  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const deleteNode = useCanvasStore((s) => s.deleteNode);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const edges = useCanvasStore((s) => s.edges);
  const sourceNode = useCanvasStore((s) => s.nodes.find((n) => n.id === id)) as
    | CanvasNode
    | undefined;

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const resolvedWidth = typeof width === 'number' && width > 0 ? width : undefined;
  const resolvedHeight = typeof height === 'number' && height > 0 ? height : undefined;

  // 是否被手动缩放过：决定编辑框的尺寸策略
  // - 缩放过：编辑框按内容撑高，但用 max-h-full 封顶（超出滚动），
  //   这样外层 flex items-center 才能把编辑框垂直居中（textarea 文字本身是顶部对齐的，
  //   如果用 h-full 撑满，文字就会贴顶）
  // - 未缩放：编辑框按内容自动撑高，胶囊随文字长高（保留原行为）
  const hasFixedHeight = resolvedHeight !== undefined;

  // 编辑框按内容自动撑高（包含自动换行产生的行，不只是手动换行符）
  const autoGrowTextarea = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // ① 实时记录上游源节点到 data.sourceId，复制时能继承
  const incomingSource = useMemo(
    () => edges.find((e) => e.target === id)?.source ?? null,
    [edges, id]
  );

  useEffect(() => {
    if (incomingSource && incomingSource !== sourceId) {
      updateNodeData(id, { sourceId: incomingSource });
    }
  }, [incomingSource, sourceId, id, updateNodeData]);

  // ② 副本自愈：复制/粘贴后若缺少来自 sourceId 的入边，自动补建
  useEffect(() => {
    if (!sourceId) return;
    const state = useCanvasStore.getState() as any;
    const already = (state.edges ?? []).some(
      (e: any) => e.target === id && e.source === sourceId
    );
    const sourceExists = (state.nodes ?? []).some((n: any) => n.id === sourceId);
    if (already || !sourceExists) return;
    if (typeof state.addEdge === 'function') {
      state.addEdge(sourceId, id);
    } else if (typeof state.onEdgesChange === 'function') {
      state.onEdgesChange([{ type: 'add', item: buildEdgeItem(sourceId, id) }]);
    }
  }, [id, sourceId]);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      autoGrowTextarea();
    }
  }, [isEditing, autoGrowTextarea]);

  // 优先使用用户自定义颜色；如果没有自定义颜色，再使用内容生成的颜色
  const customColor =
    typeof data?.color === 'string' && data.color.trim() !== ''
      ? data.color.trim()
      : null;

  const palette = useMemo(() => {
    if (customColor) {
      return {
        border: customColor,
        text: customColor,
        dot: customColor,
        ring: hexToRgba(customColor, 0.24),
      };
    }
    return getTagPalette(resolveTagColorKey(name, sourceId), isDark);
  }, [customColor, name, sourceId, isDark]);

  // 之前"第二行文字漏出来"的根因：容器只是 overflow-hidden + 固定像素高度，
  // 一旦这个高度不是行高的整数倍（比如刚好够 1.3 行），浏览器会把下一行"切一半"露出来，
  // 而不是完整隐藏。这里改成按当前像素高度算出能完整容纳几行，用 -webkit-line-clamp 硬性按整行裁切，
  // 保证永远不会露出半行文字；容纳不下的部分会显示省略号。
  const PILL_VERTICAL_PADDING = 6; // py-0.5 上下内边距合计
  const TEXT_LINE_HEIGHT = 14; // text-[10px] + leading-snug 的行高
  const maxTextLines = useMemo(() => {
    if (!resolvedHeight) return undefined; // 未手动缩放：胶囊随文字自动撑高，不需要裁切
    const available = resolvedHeight - PILL_VERTICAL_PADDING;
    return Math.max(1, Math.floor(available / TEXT_LINE_HEIGHT));
  }, [resolvedHeight]);

  const saveName = useCallback(() => {
    setIsEditing(false);
    const nextName = draft.trim() || '新标签';
    setDraft(nextName);
    updateNodeData(id, { displayName: nextName, label: nextName });
  }, [draft, id, updateNodeData]);

  return (
    <>
      {/* 工具栏：批量连接 + 删除 */}
      <NodeToolbar
        nodeId={id}
        isVisible={selected}
        position={NODE_TOOLBAR_POSITION}
        align={NODE_TOOLBAR_ALIGN}
        offset={NODE_TOOLBAR_OFFSET}
        className={NODE_TOOLBAR_CLASS}
      >
        <UiPanel className="flex items-center gap-1 rounded-full p-1">
          <UiChipButton
            className={`h-8 rounded-full px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              setIsBatchConnectOpen(true);
            }}
            title="批量连接"
          >
            <Link2 className="h-3.5 w-3.5" />
            批量连接
          </UiChipButton>
          <UiChipButton
            className="h-8 rounded-full border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25"
            onClick={(event) => {
              event.stopPropagation();
              deleteNode(id);
            }}
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </UiChipButton>
        </UiPanel>
      </NodeToolbar>

      {isBatchConnectOpen && sourceNode && (
        <BatchConnectModal
          sourceNode={sourceNode}
          onClose={() => setIsBatchConnectOpen(false)}
        />
      )}

      {/* 外层容器：不裁剪，保证两侧圆形锚点完整可见。
          minWidth/minHeight 必须和下面 NodeResizeControl 的下限保持一致（72×22，正好容纳图标+4个字）——
          否则未手动缩放过的标签会比缩放下限还窄，第一次拖拽缩放时就会突然"跳变"到最小宽度。
          修复：height 不再随 isEditing 变化，显示/编辑两种状态几何尺寸完全一致，
          彻底解决"双击编辑时标签缩小"的跳变问题 */}
      <div
        className="relative"
        style={{
          width: resolvedWidth,
          height: resolvedHeight,
          minWidth: 72,
          minHeight: 22,
        }}
        onClick={() => setSelectedNode(id)}
      >
        {/* 左上角标识，与标签组/其他节点保持一致 */}
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={
            <span
              className="flex h-5 w-5 items-center justify-center rounded-md border"
              style={{
                background: palette.ring,
                borderColor: palette.border,
                color: palette.dot,
              }}
            >
              <Tag className="h-3.5 w-3.5" />
            </span>
          }
          titleText={name}
          editable
          onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle, label: nextTitle })}
        />

        {/* 内层胶囊：文字支持自动换行，缩放时会跟着容器宽高实时重排。
            手动缩放到装不下时，用 line-clamp 按整行裁切并显示省略号，不会再露出半行文字 */}
        <div
          className="flex h-full w-full items-center gap-1 overflow-hidden rounded-xl border bg-gradient-to-r from-white/90 to-gray-50/85 px-1.5 py-1 shadow-md transition-all duration-200 backdrop-blur-md hover:shadow-lg dark:from-gray-800/90 dark:to-gray-900/85"
          style={{
            borderColor: selected ? 'var(--accent, #3b82f6)' : palette.border,
            boxShadow: selected
              ? `0 0 0 3px rgba(59,130,246,0.22), 0 8px 24px rgba(59,130,246,0.15)`
              : `0 0 0 3px ${palette.ring}, 0 2px 8px rgba(0,0,0,0.08)`,
          }}
        >
          {/* 标签图标：颜色与内容一一对应，内容不同则颜色必然不同 */}
          <Tag
            className="h-2.5 w-2.5 shrink-0 select-none"
            style={{ color: palette.dot }}
            aria-hidden
            strokeWidth={2.5}
          />
          {isEditing ? (
            // 编辑态：
            // - 未缩放过：按内容自动撑高，换行/超长文字都完整展开
            // - 缩放过：按内容撑高但 max-h-full 封顶（超出滚动），
            //   比胶囊矮时由外层 flex items-center 垂直居中，文字不再贴顶
            <textarea
              ref={inputRef}
              autoFocus
              value={draft}
              rows={1}
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setDraft(e.target.value);
                autoGrowTextarea();
              }}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  saveName();
                } else if (e.key === 'Escape') {
                  setDraft(name);
                  e.currentTarget.blur();
                }
              }}
              className={`w-full min-w-0 flex-1 resize-none break-words bg-transparent text-center text-[10px] font-semibold leading-snug tracking-tight outline-none nodrag ${
                hasFixedHeight ? 'max-h-full overflow-y-auto' : 'overflow-hidden'
              }`}
              style={{ color: palette.text }}
            />
          ) : (
            // 展示态：容器未被手动缩放时随文字自动撑高；被缩放过、装不下时按整行裁切 + 省略号
            <span
              onDoubleClick={() => setIsEditing(true)}
              onMouseDown={(e) => e.stopPropagation()}
              title={name}
              className="min-w-0 flex-1 cursor-text whitespace-normal break-words text-center text-[10px] font-semibold leading-snug tracking-tight nodrag"
              style={{
                color: palette.text,
                ...(maxTextLines
                  ? {
                      display: '-webkit-box',
                      WebkitLineClamp: maxTextLines,
                      WebkitBoxOrient: 'vertical' as const,
                      overflow: 'hidden',
                    }
                  : {}),
              }}
            >
              {name}
            </span>
          )}
        </div>

        {/* 锚点放在外层，不会被内层裁剪 */}
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-white"
          style={{ background: palette.dot }}
        />
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-2 !border-white"
          style={{ background: palette.dot }}
        />
        <NodeResizeControl
          position="bottom-right"
          minWidth={72}
          minHeight={22}
          maxWidth={640}
          maxHeight={480}
          className="!h-4 !w-4 !min-h-0 !min-w-0 !rounded-none !border-0 !bg-transparent !p-0 !opacity-0 transition-opacity duration-100 hover:!opacity-100 focus-within:!opacity-100"
        >
          <div className="pointer-events-none absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r border-black/30 transition-colors dark:border-white/35" />
        </NodeResizeControl>
      </div>
    </>
  );
});

TagNode.displayName = 'TagNode';