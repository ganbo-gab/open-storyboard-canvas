import { memo, useCallback } from 'react';
import {
  Crop,
  PenLine,
  Sparkles,
  Maximize2,
  Pencil,
  Eraser,
  Scissors,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NODE_TOOL_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { ModelConfigPicker } from './ModelConfigPicker';

export type EditOperationType = 'hd' | 'outpainting' | 'inpainting' | 'erase' | 'matting';

interface EditItem {
  id: EditOperationType;
  icon: typeof Sparkles;
  titleKey: string;
  descKey: string;
  promptTemplate: string;
}

const EDIT_ITEMS: EditItem[] = [
  {
    id: 'hd',
    icon: Sparkles,
    titleKey: 'edit.hd.title',
    descKey: 'edit.hd.desc',
    promptTemplate:
      'this is a high-definition enhancement of the reference image: keep the same people, same scene, same composition, same colors, and same pose exactly, do not change identity, do not change clothing, do not re-draw a different person, only sharpen details, recover fine texture, reduce noise and compression artifacts, restore skin micro-detail and fabric weave, output at higher effective resolution with crisp edges and natural grain, 4K quality, professional retouching, no stylization shift',
  },
  {
    id: 'outpainting',
    icon: Maximize2,
    titleKey: 'edit.outpainting.title',
    descKey: 'edit.outpainting.desc',
    promptTemplate:
      'this is an outpainting / canvas extension of the reference image: keep the original content exactly as-is inside its current boundary, extend the scene outward in a seamless and photorealistic way, match the original lighting, perspective, color grading, and camera focal length, continue walls, floors, skies, furniture, and props logically, no visible seam between original and extended regions, do not alter the original subjects or their pose',
  },
  {
    id: 'inpainting',
    icon: Pencil,
    titleKey: 'edit.inpainting.title',
    descKey: 'edit.inpainting.desc',
    promptTemplate:
      'this is a local inpainting edit of the reference image: only redraw the masked / marked area, keep everything outside the marked area byte-identical, preserve identity, clothing, background, lighting, and composition of unmasked regions, the inpainted area must blend seamlessly with surrounding color, lighting direction, focus, and grain, no visible seams, no style drift, content-aware fill',
  },
  {
    id: 'erase',
    icon: Eraser,
    titleKey: 'edit.erase.title',
    descKey: 'edit.erase.desc',
    promptTemplate:
      'this is an object-removal edit of the reference image: remove only the marked object cleanly, reconstruct the background that was behind it using plausible continuation of the surrounding wall, floor, pattern, or scenery, preserve all unmarked subjects, their pose, identity, and expression exactly, match lighting, shadow, and color grading of the surrounding scene, no ghost silhouette left behind, no cloned extra object',
  },
  {
    id: 'matting',
    icon: Scissors,
    titleKey: 'edit.matting.title',
    descKey: 'edit.matting.desc',
    promptTemplate:
      'this is a subject cutout / matting task on the reference image: isolate only the main subject(s) with a clean hair-level alpha edge, transparent background, preserve exact pose, identity, clothing, and color of the subject, no color spill from the old background, no halo or fringe, no added props, keep limbs and hands complete, output is the subject on transparent alpha, professional studio cutout quality',
  },
];

interface EditPanelProps {
  node: CanvasNode;
  isOpen: boolean;
  onClose: () => void;
  buttonRect: DOMRect;
}

export const EditPanel = memo(({ node, isOpen, onClose, buttonRect }: EditPanelProps) => {
  const { t } = useTranslation();
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);

  const handleAIPrompt = useCallback(
    async (item: EditItem) => {
      // Route the five AI edit tools through the shared NodeToolDialog so they
      // get a real editor frame + submit button. The old clipboard-only path
      // is kept as a fallback (unreachable for HD/扩图/重绘/擦除/抠图 now that
      // they're registered as tool plugins).
      const toolMapping: Record<string, typeof NODE_TOOL_TYPES[keyof typeof NODE_TOOL_TYPES] | undefined> = {
        hd: NODE_TOOL_TYPES.hd,
        outpainting: NODE_TOOL_TYPES.outpainting,
        inpainting: NODE_TOOL_TYPES.inpainting,
        erase: NODE_TOOL_TYPES.erase,
        matting: NODE_TOOL_TYPES.matting,
      };
      const toolType = toolMapping[item.id as string];
      if (toolType) {
        openToolDialog({ nodeId: node.id, toolType });
        onClose();
        return;
      }
      try {
        await navigator.clipboard.writeText(item.promptTemplate);
        onClose();
      } catch (error) {
        console.error('Failed to copy prompt to clipboard', error);
      }
    },
    [node.id, openToolDialog, onClose]
  );

  const handleCrop = useCallback(() => {
    openToolDialog({ nodeId: node.id, toolType: NODE_TOOL_TYPES.crop });
    onClose();
  }, [node.id, openToolDialog, onClose]);

  const handleAnnotate = useCallback(() => {
    openToolDialog({ nodeId: node.id, toolType: NODE_TOOL_TYPES.annotate });
    onClose();
  }, [node.id, openToolDialog, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed z-100 min-w-[300px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-xs"
      style={{
        left: `${buttonRect.left}px`,
        top: `${buttonRect.bottom + 4}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-2">
          <PenLine className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-text-dark">{t('nodeToolbar.edit')}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-2 pb-1">
        <ModelConfigPicker
          panelKey="edit"
          className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5"
        />
      </div>

      {/* Divider */}
      <div className="my-1.5 h-px bg-[rgba(255,255,255,0.1)]" />

      {/* AI Edit section */}
      <div className="space-y-0.5">
        {EDIT_ITEMS.map((item) => {
          const IconComponent = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-bg-dark"
              onClick={() => handleAIPrompt(item)}
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-dark/80">
                <IconComponent className="h-4 w-4 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-dark">
                  {t(item.titleKey)}
                </div>
                <div className="mt-0.5 text-xs text-text-muted leading-relaxed">
                  {t(item.descKey)}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Separator */}
      <div className="my-2 h-px bg-[rgba(255,255,255,0.1)]" />

      {/* Existing tools section */}
      <div className="space-y-0.5">
        {/* Crop */}
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-bg-dark"
          onClick={handleCrop}
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-dark/80">
            <Crop className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-dark">
              {t('tool.crop')}
            </div>
            <div className="mt-0.5 text-xs text-text-muted leading-relaxed">
              {t('edit.crop.desc')}
            </div>
          </div>
        </button>

        {/* Annotate */}
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-bg-dark"
          onClick={handleAnnotate}
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-dark/80">
            <PenLine className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-dark">
              {t('tool.annotate')}
            </div>
            <div className="mt-0.5 text-xs text-text-muted leading-relaxed">
              {t('edit.annotate.desc')}
            </div>
          </div>
        </button>
      </div>
    </div>
  );
});

EditPanel.displayName = 'EditPanel';
