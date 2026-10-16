import { memo, useCallback } from 'react';
import {
  Camera,
  Clapperboard,
  Film,
  Lightbulb,
  Rewind,
  FastForward,
  User,
  Grid3x3,
} from 'lucide-react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ModelConfigPicker } from './ModelConfigPicker';
import {
  resolvePromptTemplateText,
  type PromptTemplateId,
  type PromptTemplateSettingsSnapshot,
} from '@/features/canvas/application/promptTemplates';
import { useSettingsStore } from '@/stores/settingsStore';

export type MultiFunctionType =
  | 'multiCameraGrid'
  | 'plotDeduction'
  | 'continuousStoryboard'
  | 'lightingCorrection'
  | 'characterThreeView'
  | 'predictNext'
  | 'predictPrevious';

interface MultiFunctionItem {
  id: MultiFunctionType;
  icon: typeof Camera;
  titleKey: string;
  descKey: string;
  promptTemplateId: PromptTemplateId;
}

const MULTI_FUNCTION_ITEMS: MultiFunctionItem[] = [
  {
    id: 'multiCameraGrid',
    icon: Camera,
    titleKey: 'multiFunction.items.multiCameraGrid.title',
    descKey: 'multiFunction.items.multiCameraGrid.desc',
    promptTemplateId: 'multiFunction.multiCameraGrid',
  },
  {
    id: 'plotDeduction',
    icon: Clapperboard,
    titleKey: 'multiFunction.items.plotDeduction.title',
    descKey: 'multiFunction.items.plotDeduction.desc',
    promptTemplateId: 'multiFunction.plotDeduction',
  },
  {
    id: 'continuousStoryboard',
    icon: Film,
    titleKey: 'multiFunction.items.continuousStoryboard.title',
    descKey: 'multiFunction.items.continuousStoryboard.desc',
    promptTemplateId: 'multiFunction.continuousStoryboard',
  },
  {
    id: 'lightingCorrection',
    icon: Lightbulb,
    titleKey: 'multiFunction.items.lightingCorrection.title',
    descKey: 'multiFunction.items.lightingCorrection.desc',
    promptTemplateId: 'multiFunction.lightingCorrection',
  },
  {
    id: 'characterThreeView',
    icon: User,
    titleKey: 'multiFunction.items.characterThreeView.title',
    descKey: 'multiFunction.items.characterThreeView.desc',
    promptTemplateId: 'multiFunction.characterThreeView',
  },
  {
    id: 'predictNext',
    icon: FastForward,
    titleKey: 'multiFunction.items.predictNext.title',
    descKey: 'multiFunction.items.predictNext.desc',
    promptTemplateId: 'multiFunction.predictNext',
  },
  {
    id: 'predictPrevious',
    icon: Rewind,
    titleKey: 'multiFunction.items.predictPrevious.title',
    descKey: 'multiFunction.items.predictPrevious.desc',
    promptTemplateId: 'multiFunction.predictPrevious',
  },
];

/** Exported so the node toolbar (Case B) can render the same chip list without
 *  opening the legacy MultiFunctionPanel. The chip path composes the prompt
 *  template at submit time inside ImageEditNode.handleGenerate. */
export { MULTI_FUNCTION_ITEMS };
export type { MultiFunctionItem };

interface MultiFunctionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (prompt: string) => void;
  buttonRect: DOMRect;
}

export const MultiFunctionPanel = memo(({ isOpen, onClose, onApply, buttonRect }: MultiFunctionPanelProps) => {
  const { t } = useTranslation();

  const handleSelectFunction = useCallback(
    (item: MultiFunctionItem) => {
      onApply(resolvePromptTemplateText(item.promptTemplateId, useSettingsStore.getState()));
    },
    [onApply]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed z-100 min-w-[320px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-xs"
      style={{
        left: `${buttonRect.left}px`,
        top: `${buttonRect.bottom + 4}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Grid3x3 className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-text-dark">{t('multiFunction.title')}</span>
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
          panelKey="multiFunction"
          className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5"
        />
      </div>

      {/* Divider */}
      <div className="my-1.5 h-px bg-[rgba(255,255,255,0.1)]" />

      {/* Function list */}
      <div className="space-y-0.5">
        {MULTI_FUNCTION_ITEMS.map((item) => {
          const IconComponent = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-bg-dark"
              onClick={() => handleSelectFunction(item)}
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

      {/* Footer hint */}
      <div className="mt-2 border-t border-[rgba(255,255,255,0.1)] px-2.5 py-2">
        <p className="text-xs text-text-muted">{t('multiFunction.hint')}</p>
      </div>
    </div>
  );
});

MultiFunctionPanel.displayName = 'MultiFunctionPanel';

// Helper function to build multi-function prompt
export function buildMultiFunctionPrompt(functionType: MultiFunctionType): string {
  const item = MULTI_FUNCTION_ITEMS.find((i) => i.id === functionType);
  return item ? resolvePromptTemplateText(item.promptTemplateId, useSettingsStore.getState()) : '';
}

export function buildMultiFunctionPromptFromSettings(
  functionType: MultiFunctionType,
  settings: PromptTemplateSettingsSnapshot
): string {
  const item = MULTI_FUNCTION_ITEMS.find((i) => i.id === functionType);
  return item ? resolvePromptTemplateText(item.promptTemplateId, settings) : '';
}
