import { memo } from 'react';
import { X } from 'lucide-react';

import { UiIconButton } from '@/components/ui';
import { PanoramaSetupForm } from './PanoramaSetupForm';

export type PanoramaProjection = 'spherical' | 'cylindrical';
export type PanoramaSourceMode = 'ai' | 'image' | 'text';

export interface PanoramaReferenceImage {
  id: string;
  url: string;
  label: string;
  color?: string;
}

export interface PanoramaGenerateConfig {
  /** 720° 球体（full sphere, 2:1 equirectangular）or 360° 环绕（cylindrical, 4:1 ish）. */
  projection: PanoramaProjection;
  sourceMode: PanoramaSourceMode;
  referenceImages: PanoramaReferenceImage[];
  directImageUrl?: string | null;
  /** If true, the overlay handler will composite a 2:1 white reference and use image2image
   *  at --ratio 21:9 to coax a more panoramic output, regardless of sourceMode. */
  smartBase: boolean;
}

interface PanoramaPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (prompt: string, config: PanoramaGenerateConfig) => void;
  onCopyPrompt?: (prompt: string) => void;
  buttonRect: DOMRect;
  previewImageUrl?: string | null;
}

export const PanoramaPanel = memo(({ isOpen, onClose, onGenerate, onCopyPrompt, buttonRect, previewImageUrl }: PanoramaPanelProps) => {
  if (!isOpen) return null;

  const panelWidth = Math.min(1380, window.innerWidth - 24);
  const panelLeft = Math.min(Math.max(8, buttonRect.left), window.innerWidth - panelWidth - 8);
  const panelTop = buttonRect.bottom + 6;

  return (
    <div
      className="fixed z-200 rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)] overflow-hidden"
      style={{ left: panelLeft, top: panelTop, width: panelWidth }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--line)]">
        <div>
          <div className="text-sm font-semibold text-text-dark">全景图生成</div>
          <div className="mt-0.5 text-[11px] text-text-subtle">
            左侧管理素材 · 中间写提示词与参数 · 右侧选择生成方式和比例兜底
          </div>
        </div>
        <UiIconButton onClick={onClose} aria-label="关闭">
          <X className="w-4 h-4" />
        </UiIconButton>
      </div>
      <PanoramaSetupForm
        onSubmit={onGenerate}
        onCopyPrompt={onCopyPrompt}
        previewImageUrl={previewImageUrl ?? null}
      />
    </div>
  );
});

PanoramaPanel.displayName = 'PanoramaPanel';
