import { parseAspectRatio } from '../imageData';
import type { ResolvedPanelModel } from '../resolveActiveModelForPanel';
import { GenerationInputError } from './types';

export function validateImageModel(resolved: ResolvedPanelModel) {
  if (resolved.requiresApiKey && !resolved.apiKey) {
    if (resolved.resolvedByFallback) throw new GenerationInputError('missing-model', '请先配置可用的图像模型');
    throw new GenerationInputError('missing-credentials', `服务商「${resolved.providerLabel}」未填写 API Key`);
  }
  if (!resolved.usable) throw new GenerationInputError('missing-model', '当前模型不可用');
}
export function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[]
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

function resolveSizeToPixels(size: string): number {
  const normalizedSize = size.trim();
  const pixelSizeMatch = /^(\d{3,5})x(\d{3,5})$/i.exec(normalizedSize);
  if (pixelSizeMatch) {
    return Math.max(Number(pixelSizeMatch[1]), Number(pixelSizeMatch[2]));
  }
  const sizeMap: Record<string, number> = {
    '0.5K': 512,
    '1K': 1024,
    '2K': 2048,
    '4K': 4096,
    '1k': 1024,
    '2k': 2048,
    '4k': 4096,
  };
  return sizeMap[normalizedSize] ?? sizeMap[normalizedSize.toUpperCase()] ?? 1024;
}

/**
 * 生成网格图片的 dataURL
 * 根据用户设置的分辨率、行列数和比例生成白底黑线的网格图
 * 用于帮助 API 更好地生成分镜
 */
export function generateGridImageDataUrl(
  aspectRatio: string,
  rows: number,
  cols: number,
  resolution: string,
  lineThicknessPercent: number = 0.4
): string {
  const [ratioW = '16', ratioH = '9'] = aspectRatio.split(':');
  const ratioWNum = parseFloat(ratioW);
  const ratioHNum = parseFloat(ratioH);

  // 根据分辨率计算画布的总像素尺寸
  const totalPixels = resolveSizeToPixels(resolution);

  // 根据比例计算画布的实际宽高
  // 宽度 = 总像素，高度根据比例计算
  const canvasWidth = totalPixels;
  const canvasHeight = Math.round(totalPixels * (ratioHNum / ratioWNum));
  const thickness = Math.max(
    1,
    Math.round((Math.min(canvasWidth, canvasHeight) * lineThicknessPercent) / 100)
  );

  // 计算单个格子的像素尺寸
  const cellWidth = canvasWidth / cols;
  const cellHeight = canvasHeight / rows;

  // 创建 canvas 并绘制
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to create canvas context');
  }

  // 白色背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 黑色线条
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = thickness;

  // 绘制内部垂直线 (不包含最左边和最右边)
  for (let i = 1; i < cols; i++) {
    const x = i * cellWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  // 绘制内部水平线 (不包含最上边和最下边)
  for (let i = 1; i < rows; i++) {
    const y = i * cellHeight;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}
