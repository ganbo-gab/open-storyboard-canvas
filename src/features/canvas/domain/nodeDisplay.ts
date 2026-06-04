import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
} from './canvasNodes';

export const DEFAULT_NODE_DISPLAY_NAME: Record<CanvasNodeType, string> = {
  [CANVAS_NODE_TYPES.upload]: '上传图片',
  [CANVAS_NODE_TYPES.imageEdit]: 'AI 图片',
  [CANVAS_NODE_TYPES.aiVideo]: 'AI 视频',
  [CANVAS_NODE_TYPES.aiText]: 'AI 文本',
  [CANVAS_NODE_TYPES.exportImage]: '生成图像',
  [CANVAS_NODE_TYPES.video]: '生成视频',
  [CANVAS_NODE_TYPES.textAnnotation]: '文本节点',
  [CANVAS_NODE_TYPES.jsonCard]: 'JSON 卡片',
  [CANVAS_NODE_TYPES.group]: '分组',
  [CANVAS_NODE_TYPES.storyboardSplit]: '切割结果',
  [CANVAS_NODE_TYPES.storyboardGen]: '分镜生成',
  [CANVAS_NODE_TYPES.panorama]: '全景图',
  [CANVAS_NODE_TYPES.blueprint]: '导演台',
};

export const EXPORT_RESULT_DISPLAY_NAME: Record<ExportImageNodeResultKind, string> = {
  generic: '生成图像',
  storyboardGenOutput: '分镜输出',
  storyboardSplitExport: '切割导出',
  storyboardFrameEdit: '分镜帧',
};

function resolveExportResultDefault(data: Partial<CanvasNodeData>): string {
  const resultKind = (data as { resultKind?: ExportImageNodeResultKind }).resultKind ?? 'generic';
  return EXPORT_RESULT_DISPLAY_NAME[resultKind];
}

export function getDefaultNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  if (type === CANVAS_NODE_TYPES.exportImage) {
    return resolveExportResultDefault(data);
  }
  return DEFAULT_NODE_DISPLAY_NAME[type];
}

export function resolveNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (type === CANVAS_NODE_TYPES.blueprint && customTitle === '蓝图') {
    return getDefaultNodeDisplayName(type, data);
  }
  if (customTitle) {
    return customTitle;
  }

  if (type === CANVAS_NODE_TYPES.group) {
    const legacyLabel = typeof (data as { label?: string }).label === 'string'
      ? (data as { label?: string }).label?.trim()
      : '';
    if (legacyLabel) {
      return legacyLabel;
    }
  }

  return getDefaultNodeDisplayName(type, data);
}

export function isNodeUsingDefaultDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): boolean {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!customTitle) {
    return true;
  }
  if (type === CANVAS_NODE_TYPES.blueprint && customTitle === '蓝图') {
    return true;
  }
  return customTitle === getDefaultNodeDisplayName(type, data);
}
