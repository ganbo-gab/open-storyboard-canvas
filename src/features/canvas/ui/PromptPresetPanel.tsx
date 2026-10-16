import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Image as ImageIcon, Settings2, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useSettingsStore, type PromptPreset } from '@/stores/settingsStore';
import { ModelConfigPicker, type ModelConfigValue } from './ModelConfigPicker';

interface PromptPresetPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (presetId: string, modelConfig: ModelConfigValue) => Promise<void> | void;
  buttonRect: DOMRect;
  previewImageUrl?: string | null;
}

function pickInitialRatio(supportedRatios: string[], currentRatio?: string): string {
  if (currentRatio && supportedRatios.includes(currentRatio)) return currentRatio;
  if (supportedRatios.includes('auto')) return 'auto';
  return supportedRatios[0] ?? 'auto';
}

export const PromptPresetPanel = memo(({
  isOpen,
  onClose,
  onGenerate,
  buttonRect,
  previewImageUrl,
}: PromptPresetPanelProps) => {
  const { t } = useTranslation();
  const catalog = useImageModelCatalog();
  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const persistedModelConfig = useSettingsStore((state) => (state.lastModelConfigByPanel ?? {}).promptPreset);
  const setPanelModelConfig = useSettingsStore((state) => state.setPanelModelConfig);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfigValue | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const initialModelConfig = useMemo<ModelConfigValue | null>(() => {
    const persistedEntry = persistedModelConfig
      ? catalog.find((entry) => entry.id === persistedModelConfig.entryId)
      : null;
    if (persistedEntry?.usable && persistedModelConfig) {
      return {
        entryId: persistedModelConfig.entryId,
        ratio: pickInitialRatio(persistedEntry.supportedRatios, persistedModelConfig.ratio),
        extraParams: persistedModelConfig.extraParams,
      };
    }

    const firstEntry = catalog.find((entry) => entry.usable) ?? catalog[0];
    if (!firstEntry) return null;
    return {
      entryId: firstEntry.id,
      ratio: pickInitialRatio(firstEntry.supportedRatios),
    };
  }, [catalog, persistedModelConfig]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedPresetId((current) =>
      current && promptPresets.some((preset) => preset.id === current) ? current : null
    );
    setModelConfig((current) =>
      current && catalog.some((entry) => entry.id === current.entryId) ? current : initialModelConfig
    );
    setIsSubmitting(false);
  }, [catalog, initialModelConfig, isOpen, promptPresets]);

  const selectedPreset = useMemo<PromptPreset | null>(
    () => promptPresets.find((preset) => preset.id === selectedPresetId) ?? null,
    [promptPresets, selectedPresetId]
  );

  const handleModelConfigChange = useCallback((next: ModelConfigValue) => {
    setModelConfig(next);
    setPanelModelConfig('promptPreset', next);
  }, [setPanelModelConfig]);

  const handleManagePresets = useCallback(() => {
    onClose();
    openSettingsDialog({ category: 'promptPresets' });
  }, [onClose]);

  const handleGenerate = useCallback(async () => {
    if (!selectedPreset || !modelConfig || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onGenerate(selectedPreset.id, modelConfig);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, modelConfig, onGenerate, selectedPreset]);

  if (!isOpen) {
    return null;
  }

  const panelWidth = 390;
  const viewportWidth = typeof window === 'undefined' ? panelWidth + 16 : window.innerWidth;
  const panelLeft = Math.min(Math.max(8, buttonRect.left), Math.max(8, viewportWidth - panelWidth - 8));
  const panelTop = buttonRect.bottom + 6;
  const canGenerate = Boolean(selectedPreset && modelConfig && !isSubmitting);

  return (
    <div
      className="fixed z-100 w-[390px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 shadow-2xl backdrop-blur-xs"
      style={{ left: `${panelLeft}px`, top: `${panelTop}px` }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate text-sm font-medium text-text-dark">
            {t('promptPresetPanel.title')}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
          title={t('common.close') as string}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-2 px-3 pb-3">
        {previewImageUrl && (
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
            <img
              src={previewImageUrl}
              alt={t('promptPresetPanel.sourcePreview') as string}
              className="h-10 w-10 shrink-0 rounded-md object-cover"
              draggable={false}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-white/80">
                <ImageIcon className="h-3 w-3 text-accent" />
                {t('promptPresetPanel.sourcePreview')}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-text-muted">
                {t('promptPresetPanel.sourcePreviewHint')}
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-white/10 bg-black/20 p-2">
          <div className="mb-1.5 text-[11px] font-medium text-white/72">
            {t('promptPresetPanel.modelTitle')}
          </div>
          <ModelConfigPicker
            panelKey="promptPreset"
            value={modelConfig ?? undefined}
            onChange={handleModelConfigChange}
            className="rounded-md border border-white/10 bg-white/3 px-2 py-1.5"
          />
        </div>

        <div className="rounded-lg border border-white/10 bg-black/20">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2.5 py-2">
            <span className="text-[11px] font-medium text-white/72">
              {t('promptPresetPanel.presetTitle')}
            </span>
            <button
              type="button"
              onClick={handleManagePresets}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/70 transition-colors hover:border-white/25 hover:text-white/90"
            >
              <Settings2 className="h-3 w-3" />
              {t('nodeToolbar.managePromptPresets')}
            </button>
          </div>

          {promptPresets.length > 0 ? (
            <div className="ui-scrollbar max-h-[190px] space-y-1 overflow-y-auto p-2">
              {promptPresets.map((preset) => {
                const active = preset.id === selectedPresetId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setSelectedPresetId(preset.id)}
                    className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? 'border-accent/55 bg-accent/16 text-white'
                        : 'border-transparent text-text-dark hover:border-white/12 hover:bg-bg-dark'
                    }`}
                    title={preset.prompt}
                  >
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{preset.name}</span>
                      <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-text-muted">
                        {preset.prompt}
                      </span>
                    </span>
                    {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="m-2 rounded-lg border border-dashed border-white/12 bg-bg-dark/35 px-3 py-4 text-center text-xs text-text-muted">
              {t('nodeToolbar.promptPresetEmpty')}
            </div>
          )}
        </div>

        {selectedPreset && (
          <div className="rounded-lg border border-white/10 bg-white/3 p-2.5">
            <div className="mb-1 text-[11px] font-medium text-white/72">
              {t('promptPresetPanel.selectedPrompt')}
            </div>
            <div className="ui-scrollbar max-h-[76px] overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-text-muted">
              {selectedPreset.prompt}
            </div>
          </div>
        )}

        <button
          type="button"
          disabled={!canGenerate}
          onClick={() => { void handleGenerate(); }}
          className={`flex h-9 w-full items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
            canGenerate
              ? 'border-accent/50 bg-accent/22 text-white hover:bg-accent/30'
              : 'cursor-not-allowed border-white/10 bg-white/3 text-white/35'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {isSubmitting ? t('promptPresetPanel.submitting') : t('promptPresetPanel.generate')}
        </button>
      </div>
    </div>
  );
});

PromptPresetPanel.displayName = 'PromptPresetPanel';
