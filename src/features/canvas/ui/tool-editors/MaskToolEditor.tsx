import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { VisualToolEditorProps } from './types';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

/**
 * Mask brush editor shared by the 重绘 / 擦除 tools.
 *
 * Draws the source image into a canvas and lets the user paint a soft-black
 * mask on a transparent overlay canvas. The resulting mask is serialised to
 * a base64 PNG data URL and stored under `options.maskImage` so the
 * downstream AI processor can forward it. Strokes are stored as ref state
 * (not React state) so painting stays 60 fps.
 */
export function MaskToolEditor({ plugin, sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const brushSize = Number(options.brushSize ?? 24);
  const mode = (options.__maskMode as 'paint' | 'erase' | undefined) ?? 'paint';
  const promptKey = plugin.fields.find((f) => f.key === 'prompt') ? 'prompt' : null;

  // Load the source image and size the canvases to match its natural pixels.
  useEffect(() => {
    const src = resolveImageDisplayUrl(sourceImageUrl);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
      const base = baseCanvasRef.current;
      if (base) {
        base.width = img.naturalWidth;
        base.height = img.naturalHeight;
        const ctx = base.getContext('2d');
        if (ctx) ctx.drawImage(img, 0, 0);
      }
      const mask = maskCanvasRef.current;
      if (mask) {
        mask.width = img.naturalWidth;
        mask.height = img.naturalHeight;
        const mctx = mask.getContext('2d');
        mctx?.clearRect(0, 0, mask.width, mask.height);
      }
    };
    img.src = src;
  }, [sourceImageUrl]);

  // Fit the canvases inside a bounded container while preserving aspect.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !imgNatural) return;
    const maxW = host.clientWidth - 8;
    const maxH = 480;
    const ar = imgNatural.w / imgNatural.h;
    let w = maxW;
    let h = w / ar;
    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }
    for (const c of [baseCanvasRef.current, maskCanvasRef.current]) {
      if (!c) continue;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
  }, [imgNatural]);

  const commitMaskToOptions = useCallback(() => {
    const mask = maskCanvasRef.current;
    if (!mask) return;
    try {
      const dataUrl = mask.toDataURL('image/png');
      onOptionsChange({ ...options, maskImage: dataUrl });
    } catch {
      /* ignore export errors — e.g. tainted canvas */
    }
  }, [onOptionsChange, options]);

  const canvasPointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width;
    const sy = c.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  const strokeLine = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.55)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }, [brushSize, mode]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    const p = canvasPointFromEvent(e);
    strokeLine(p, p);
    lastPointRef.current = p;
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const p = canvasPointFromEvent(e);
    const prev = lastPointRef.current ?? p;
    strokeLine(prev, p);
    lastPointRef.current = p;
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    isDrawingRef.current = false;
    lastPointRef.current = null;
    commitMaskToOptions();
  };

  const clearMask = () => {
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    ctx?.clearRect(0, 0, mask.width, mask.height);
    commitMaskToOptions();
  };

  return (
    <div className="space-y-3">
      <div ref={hostRef} className="relative inline-block w-full">
        <canvas ref={baseCanvasRef} className="rounded-sm border border-white/10 bg-black/40 block" />
        <canvas
          ref={maskCanvasRef}
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <label className="flex items-center gap-1">
          <span>笔刷</span>
          <input
            type="range"
            min={4}
            max={120}
            step={2}
            value={brushSize}
            onChange={(e) => onOptionsChange({ ...options, brushSize: Number(e.target.value) })}
            className="accent-accent"
          />
          <span className="w-8 text-right">{brushSize}px</span>
        </label>
        <div className="inline-flex gap-1">
          <button
            type="button"
            onClick={() => onOptionsChange({ ...options, __maskMode: 'paint' })}
            className={`rounded-sm px-2 py-0.5 border transition-colors ${mode === 'paint' ? 'border-accent/60 bg-accent/20 text-accent' : 'border-white/10 bg-white/5 text-white/65 hover:border-white/25'}`}
          >涂</button>
          <button
            type="button"
            onClick={() => onOptionsChange({ ...options, __maskMode: 'erase' })}
            className={`rounded-sm px-2 py-0.5 border transition-colors ${mode === 'erase' ? 'border-accent/60 bg-accent/20 text-accent' : 'border-white/10 bg-white/5 text-white/65 hover:border-white/25'}`}
          >擦</button>
          <button
            type="button"
            onClick={clearMask}
            className="rounded-sm px-2 py-0.5 border border-white/10 bg-white/5 text-white/65 hover:border-red-400/50 hover:text-red-300"
          >清空</button>
        </div>
      </div>
      {promptKey && (
        <div>
          <label className="mb-1 block text-xs text-text-muted">
            {plugin.fields.find((f) => f.key === promptKey)!.label}
          </label>
          <input
            type="text"
            value={String(options[promptKey] ?? '')}
            onChange={(e) => onOptionsChange({ ...options, [promptKey]: e.target.value })}
            placeholder={(plugin.fields.find((f) => f.key === promptKey) as { placeholder?: string }).placeholder ?? ''}
            className="w-full rounded-sm bg-white/5 border border-white/10 px-2 py-1 text-xs text-text-dark outline-hidden focus:border-white/25"
          />
        </div>
      )}
    </div>
  );
}

export default memo(MaskToolEditor);
