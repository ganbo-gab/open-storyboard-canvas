import { memo, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { ChevronDown, Check, Settings2 } from 'lucide-react';

import {
  formatRatio,
  useImageModelCatalog,
  type CatalogEntry,
} from '@/features/canvas/application/modelCatalog';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ModelConfigValue {
  entryId: string;
  ratio: string;
  extraParams?: Record<string, unknown>;
}

interface ModelConfigPickerProps {
  /** Unique key per panel — used to persist last-used config under
   *  `settingsStore.lastModelConfigByPanel[panelKey]`. */
  panelKey: string;
  className?: string;
  /** Compact chip-row layout (for inline use in panels) vs stacked form. */
  compact?: boolean;
  /** Optional panel-specific preferred ratio, e.g. panorama uses 2:1/4:1. */
  preferredRatio?: string | null;
  value?: ModelConfigValue;
  onChange?: (value: ModelConfigValue) => void;
}

/**
 * Reusable model/provider/ratio picker that reads the unified image-model
 * catalog (built-in + custom + Dreamina) and persists the user's last choice
 * per panel to `settingsStore`.
 *
 * It does NOT directly drive generation — panels read the persisted value on
 * submit and route through their existing gateway. Custom-provider / Dreamina
 * entries are selectable but show a subdued "not ready" label until the
 * submission adapter lands.
 */
function resolvePreferredRatio(
  supportedRatios: string[],
  preferredRatio?: string | null,
  currentRatio?: string,
  options: { preferAutoFallback?: boolean } = {}
): string {
  const ratios = supportedRatios.map((ratio) => ratio.trim()).filter(Boolean);
  if (preferredRatio && ratios.includes(preferredRatio)) return preferredRatio;
  if (options.preferAutoFallback && ratios.includes('auto')) return 'auto';
  if (currentRatio && ratios.includes(currentRatio)) return currentRatio;
  return ratios[0] ?? 'auto';
}

function stopPickerWheel(event: WheelEvent<HTMLElement>) {
  event.stopPropagation();
}

export const ModelConfigPicker = memo(({
  panelKey,
  className,
  compact = true,
  preferredRatio,
  value,
  onChange,
}: ModelConfigPickerProps) => {
  const catalog = useImageModelCatalog();
  const persisted = useSettingsStore(
    (s) => (s.lastModelConfigByPanel ?? {})[panelKey]
  );
  const setPanelModelConfig = useSettingsStore((s) => s.setPanelModelConfig);

  const firstUsable = catalog.find((e) => e.usable);
  const persistedEntry = persisted ? catalog.find((e) => e.id === persisted.entryId) : undefined;
  const persistedUsableConfig = persisted && persistedEntry?.usable ? persisted : undefined;
  const current: ModelConfigValue = value ?? (onChange ? undefined : persistedUsableConfig) ?? (firstUsable
    ? {
      entryId: firstUsable.id,
      ratio: resolvePreferredRatio(firstUsable.supportedRatios, preferredRatio, undefined, {
        preferAutoFallback: Boolean(preferredRatio),
      }),
    }
    : { entryId: catalog[0]?.id ?? '', ratio: 'auto' });

  const currentEntry = useMemo(() => catalog.find((e) => e.id === current.entryId), [catalog, current.entryId]);
  const lastPreferredRatioRef = useRef<string | null>(preferredRatio ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const webSearchEnabled = Boolean(current.extraParams?.webSearch);

  const byProvider = useMemo(() => {
    const map = new Map<string, CatalogEntry[]>();
    for (const entry of catalog) {
      const bucket = map.get(entry.providerLabel) ?? [];
      bucket.push(entry);
      map.set(entry.providerLabel, bucket);
    }
    return map;
  }, [catalog]);

  const modelsForCurrentProvider = useMemo(
    () => (currentEntry ? (byProvider.get(currentEntry.providerLabel) ?? []) : []),
    [byProvider, currentEntry]
  );

  const closeAll = useCallback(() => {
    setProviderOpen(false);
    setModelOpen(false);
    setParamsOpen(false);
  }, []);

  const commitConfig = useCallback((next: ModelConfigValue) => {
    if (onChange) {
      onChange(next);
      return;
    }
    setPanelModelConfig(panelKey, next);
  }, [onChange, panelKey, setPanelModelConfig]);

  useEffect(() => {
    if (onChange || persistedUsableConfig || !firstUsable) return;
    setPanelModelConfig(panelKey, {
      entryId: firstUsable.id,
      ratio: resolvePreferredRatio(firstUsable.supportedRatios, preferredRatio, undefined, {
        preferAutoFallback: Boolean(preferredRatio),
      }),
    });
  }, [firstUsable, onChange, panelKey, persistedUsableConfig, preferredRatio, setPanelModelConfig]);

  useEffect(() => {
    const nextPreferredRatio = preferredRatio ?? null;
    const preferredRatioChanged = lastPreferredRatioRef.current !== nextPreferredRatio;
    lastPreferredRatioRef.current = nextPreferredRatio;
    if (!currentEntry || !preferredRatio) return;
    const currentRatioSupported = currentEntry.supportedRatios.includes(current.ratio);
    if (!preferredRatioChanged && currentRatioSupported) return;
    const nextRatio = resolvePreferredRatio(
      currentEntry.supportedRatios,
      preferredRatio,
      currentRatioSupported ? current.ratio : undefined,
      { preferAutoFallback: preferredRatioChanged || !currentRatioSupported }
    );
    if (current.ratio === nextRatio) return;
    commitConfig({
      entryId: current.entryId,
      ratio: nextRatio,
      extraParams: current.extraParams,
    });
  }, [commitConfig, current.entryId, current.extraParams, current.ratio, currentEntry, preferredRatio]);

  useEffect(() => {
    if (!providerOpen && !modelOpen && !paramsOpen) return;
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) return;
      closeAll();
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => document.removeEventListener('mousedown', handleOutside, true);
  }, [closeAll, modelOpen, paramsOpen, providerOpen]);

  const handlePickProvider = useCallback((label: string) => {
    const firstInProvider = byProvider.get(label)?.[0];
    if (firstInProvider) {
      commitConfig({
        entryId: firstInProvider.id,
        ratio: resolvePreferredRatio(firstInProvider.supportedRatios, preferredRatio, undefined, {
          preferAutoFallback: Boolean(preferredRatio),
        }),
        extraParams: current.extraParams,
      });
    }
    setProviderOpen(false);
  }, [byProvider, commitConfig, current.extraParams, preferredRatio]);

  const handlePickModel = useCallback((entry: CatalogEntry) => {
    const ratio = resolvePreferredRatio(entry.supportedRatios, preferredRatio, current.ratio, {
      preferAutoFallback: Boolean(preferredRatio),
    });
    commitConfig({ entryId: entry.id, ratio, extraParams: current.extraParams });
    setModelOpen(false);
  }, [commitConfig, current.ratio, current.extraParams, preferredRatio]);

  const handlePickRatio = useCallback((ratio: string) => {
    commitConfig({ entryId: current.entryId, ratio, extraParams: current.extraParams });
  }, [commitConfig, current.entryId, current.extraParams]);

  const handleToggleWebSearch = useCallback((next: boolean) => {
    const nextExtra = { ...(current.extraParams ?? {}) };
    if (next) nextExtra.webSearch = true;
    else delete nextExtra.webSearch;
    commitConfig({
      entryId: current.entryId,
      ratio: current.ratio,
      extraParams: nextExtra,
    });
  }, [commitConfig, current.entryId, current.ratio, current.extraParams]);

  const updateExtra = useCallback((patch: Record<string, unknown>) => {
    const nextExtra = { ...(current.extraParams ?? {}) };
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '') delete nextExtra[key];
      else nextExtra[key] = value;
    });
    commitConfig({
      entryId: current.entryId,
      ratio: current.ratio,
      extraParams: nextExtra,
    });
  }, [commitConfig, current.entryId, current.ratio, current.extraParams]);

  const hasResolutions = (currentEntry?.supportedResolutions?.length ?? 0) > 0;
  const hasModelVersions = (currentEntry?.supportedModelVersions?.length ?? 0) > 0;
  const supportedRatios = currentEntry?.supportedRatios ?? ['auto'];
  const hasAdvancedParams = Boolean(current.extraParams?.seed || current.extraParams?.negativePrompt);
  const hasParamsBox = true;

  if (catalog.length === 0) {
    return (
      <span className={`text-[11px] text-white/45 ${className ?? ''}`}>
        暂无可用模型 — 请先在设置中添加服务商
      </span>
    );
  }

  const chipCls =
    'inline-flex h-6 min-w-0 max-w-[110px] shrink items-center gap-1 overflow-hidden whitespace-nowrap rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1 text-[11px] text-text-dark shadow-sm transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';
  const menuCls = 'ui-scrollbar nowheel absolute bottom-full z-[1200] mb-1 overflow-y-auto rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1 shadow-2xl';

  return (
    <div
      ref={rootRef}
      className={`flex min-w-0 items-center gap-1.5 ${compact ? 'flex-nowrap' : 'flex-col items-stretch'} ${className ?? ''}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="relative min-w-0 max-w-[110px]">
        <button type="button" className={chipCls} onClick={() => { setProviderOpen((v) => !v); setModelOpen(false); setParamsOpen(false); }} title={currentEntry?.providerLabel ?? '选择服务商'}>
          <span className="min-w-0 truncate">{currentEntry?.providerLabel ?? '选择服务商'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        {providerOpen && (
          <div className={`${menuCls} left-0 max-h-[220px] min-w-[140px]`} onWheelCapture={stopPickerWheel}>
            {Array.from(byProvider.keys()).map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => handlePickProvider(label)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-text-dark hover:bg-[var(--canvas-node-menu-hover)]"
                title={label}
              >
                {currentEntry?.providerLabel === label && <Check className="h-3 w-3 shrink-0 text-accent" />}
                <span className="min-w-0 truncate">{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative min-w-0 max-w-[120px]">
        <button type="button" className={chipCls} onClick={() => { setModelOpen((v) => !v); setProviderOpen(false); setParamsOpen(false); }} title={currentEntry?.modelLabel ?? '选择模型'}>
          <span className="min-w-0 truncate">{currentEntry?.modelLabel ?? '选择模型'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        {modelOpen && (
          <div className={`${menuCls} left-0 max-h-[260px] min-w-[220px] max-w-[280px]`} onWheelCapture={stopPickerWheel}>
            {modelsForCurrentProvider.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => handlePickModel(entry)}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-[var(--canvas-node-menu-hover)] ${entry.usable ? 'text-text-dark' : 'text-text-muted/55'}`}
                title={entry.modelLabel}
              >
                <span className="min-w-0 flex-1 truncate">{entry.modelLabel}</span>
                {!entry.usable && entry.notReadyReason && (
                  <span className="shrink-0 text-[9px] text-amber-400/80">接入中</span>
                )}
                {entry.id === current.entryId && <Check className="h-3 w-3 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {hasParamsBox && (
        <div className="relative min-w-0 max-w-[90px]">
          <button
            type="button"
            className={`${chipCls} ${webSearchEnabled ? '!border-accent/70 !text-accent' : ''}`}
            onClick={() => { setParamsOpen((v) => !v); setProviderOpen(false); setModelOpen(false); }}
            title="比例 / 分辨率 / 模型版本 / 联网 / 种子 / 反向提示词"
          >
            <Settings2 className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">参数</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
          {paramsOpen && (
            <div
              className="nowheel absolute bottom-full right-0 z-[1200] mb-1 min-w-[280px] max-w-[320px] space-y-2 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl"
              onWheelCapture={stopPickerWheel}
            >
              <div>
                <div className="mb-1 text-[10px] text-text-muted">比例</div>
                <div className="flex flex-wrap gap-1">
                  {supportedRatios.map((r) => {
                    const active = r === current.ratio;
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => handlePickRatio(r)}
                        className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-accent' : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'}`}
                      >{formatRatio(r)}</button>
                    );
                  })}
                </div>
              </div>
              {hasResolutions && (
                <div>
                  <div className="mb-1 text-[10px] text-text-muted">分辨率</div>
                  <div className="flex flex-wrap gap-1">
                    {(currentEntry?.supportedResolutions ?? []).map((r) => {
                      const active = (current.extraParams?.resolutionType as string | undefined) === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => updateExtra({ resolutionType: active ? undefined : r })}
                          className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-accent' : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'}`}
                        >{r}</button>
                      );
                    })}
                  </div>
                </div>
              )}
              {hasModelVersions && (
                <div>
                  <div className="mb-1 text-[10px] text-text-muted">模型版本</div>
                  <div className="flex flex-wrap gap-1">
                    {(currentEntry?.supportedModelVersions ?? []).map((v) => {
                      const active = (current.extraParams?.modelVersion as string | undefined) === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => updateExtra({ modelVersion: active ? undefined : v })}
                          className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-accent' : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'}`}
                        >{v}</button>
                      );
                    })}
                  </div>
                </div>
              )}
              {currentEntry?.supportsWebSearch && (
                <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-[var(--canvas-node-menu-hover)]">
                  <input
                    type="checkbox"
                    checked={webSearchEnabled}
                    onChange={(e) => handleToggleWebSearch(e.target.checked)}
                    className="mt-0.5 h-3 w-3 accent-accent"
                  />
                  <div className="flex-1">
                    <div className="text-[11px] text-text-dark">启用联网搜索</div>
                  </div>
                </label>
              )}
              <div className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="text-[11px] font-medium text-text-dark">高级可选参数</span>
                  <span className={`text-[10px] ${hasAdvancedParams ? 'text-accent' : 'text-text-muted'}`}>
                    {advancedOpen ? '收起' : hasAdvancedParams ? '已设置' : '展开'}
                  </span>
                </button>
                {advancedOpen && (
                  <div className="mt-2 space-y-2">
                    <div className="text-[10px] leading-4 text-text-muted">
                      一般不用填。未展开或留空时，不会向接口附加 seed / 反向提示词。
                    </div>
                  <div>
                    <div className="mb-1 text-[10px] text-text-muted">种子（seed）</div>
                    <input
                      type="number"
                      value={(current.extraParams?.seed as number | undefined) ?? ''}
                      onChange={(e) => updateExtra({ seed: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
                      placeholder="通常留空；留空 = 随机"
                      className="w-full rounded border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg-strong)] px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/60"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] text-text-muted">反向提示词 / 排除</div>
                    <textarea
                      value={(current.extraParams?.negativePrompt as string | undefined) ?? ''}
                      onChange={(e) => updateExtra({ negativePrompt: e.target.value.trim() || undefined })}
                      placeholder="通常留空；仅在支持时填写排除内容"
                      rows={2}
                      className="w-full resize-none rounded border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg-strong)] px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/60"
                    />
                  </div>
                </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
});

ModelConfigPicker.displayName = 'ModelConfigPicker';

interface ModelConfigButtonProps {
  panelKey: string;
}

/**
 * Compact "⚙ 配置模型" button that opens a small popover containing the same
 * provider / model / ratio chips as ModelConfigPicker. Used by panels whose
 * body is too narrow to inline the chips (multi-function, edit).
 */
export const ModelConfigButton = memo(({ panelKey }: ModelConfigButtonProps) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[10px] text-[var(--canvas-node-button-text)] transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
        title="配置当前面板使用的模型"
      >
        <Settings2 className="h-3 w-3" />
        配置模型
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[900]" onClick={() => setOpen(false)} />
          <div
            className="nowheel absolute bottom-full left-0 z-[1000] mb-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onWheelCapture={stopPickerWheel}
          >
            <ModelConfigPicker panelKey={panelKey} />
          </div>
        </>
      )}
    </div>
  );
});

ModelConfigButton.displayName = 'ModelConfigButton';
