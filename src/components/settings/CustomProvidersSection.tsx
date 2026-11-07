import { memo, useCallback, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, List, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiBadge, UiButton, UiIconButton, UiModal } from '@/components/ui';
import {
  isChatCustomProvider,
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { hasCustomProviderCredential } from '@/features/canvas/application/providerAvailability';
import {
  testCustomProviderConnectivity,
  type CustomProviderTestResult,
} from '@/features/canvas/infrastructure/providerGateway';
import {
  resolveCustomProviderBodyMode,
  type CustomProviderBodyMode,
} from '@/features/canvas/infrastructure/customProviderTransport';

interface CustomProvidersSectionProps {
  /** Lets the host switch the sidebar when the user clicks 新增配置 or 查看配置. */
  onRequestAdd?: (target?: 'new' | 'old' | 'video' | 'chat' | 'comfyui') => void;
}

function providerKindLabel(provider: CustomProviderConfig): {
  label?: string;
  labelKey?: 'settings.imageProviderConfig.preset' | 'settings.imageProviderConfig.fullCustom';
  tone: 'neutral' | 'accent' | 'success' | 'warning';
} {
  if (provider.apiStyle === 'comfyui') {
    return {
      label: 'ComfyUI',
      tone: 'success',
    };
  }
  if (isChatCustomProvider(provider)) {
    return {
      label: '文本对话',
      tone: 'neutral',
    };
  }
  if (isVideoCustomProvider(provider)) {
    return {
      label: '视频配置',
      tone: 'neutral',
    };
  }
  if (provider.extraParams?.providerConfigVersion === 'new-v1') {
    return {
      labelKey: 'settings.imageProviderConfig.preset',
      tone: 'accent',
    };
  }
  return {
    labelKey: 'settings.imageProviderConfig.fullCustom',
    tone: 'warning',
  };
}

function formatBodyModeLabel(mode: CustomProviderBodyMode): string {
  if (mode === 'multipart') return 'multipart/form-data';
  if (mode === 'form-urlencoded') return 'application/x-www-form-urlencoded';
  if (mode === 'signed') return '签名/代理';
  return 'JSON';
}

function formatImportPlanPreview(extraParams: Record<string, unknown> | undefined): string | null {
  const plan = extraParams?.importPlan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return null;
  }
  try {
    return JSON.stringify(plan, null, 2);
  } catch {
    return null;
  }
}

/**
 * "我的配置" section: list of saved configs. Each row has 查看配置 + 查看模型
 * buttons. 查看配置 asks the host to open the matching channel/add page.
 */
export const CustomProvidersSection = memo(({ onRequestAdd }: CustomProvidersSectionProps) => {
  const { t } = useTranslation();
  const providers = useCustomProvidersStore((s) => s.providers);
  const removeProvider = useCustomProvidersStore((s) => s.removeProvider);
  const [modelsDialogFor, setModelsDialogFor] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, CustomProviderTestResult | undefined>>({});

  const handleTestSavedProvider = useCallback(async (provider: CustomProviderConfig) => {
    setTestingProviderId(provider.id);
    setProviderTestResults((results) => ({ ...results, [provider.id]: undefined }));
    try {
      const res = await testCustomProviderConnectivity(provider);
      setProviderTestResults((results) => ({ ...results, [provider.id]: res }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProviderTestResults((results) => ({
        ...results,
        [provider.id]: { ok: false, errorMessage: message },
      }));
    } finally {
      setTestingProviderId(null);
    }
  }, []);

  const modelsDialogProvider = useMemo(
    () => providers.find((p) => p.id === modelsDialogFor) ?? null,
    [providers, modelsDialogFor],
  );
  const modelsDialogExtraParams = modelsDialogProvider?.extraParams ?? {};
  const modelsDialogDurations = Array.isArray(modelsDialogExtraParams.supportedDurations)
    ? modelsDialogExtraParams.supportedDurations.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const modelsDialogRatios = Array.isArray(modelsDialogExtraParams.supportedRatios)
    ? modelsDialogExtraParams.supportedRatios.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const handleEdit = useCallback((id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    // The add form now lives in the channel settings page, so this list only
    // asks the host to switch to that page.
    onRequestAdd?.(p.apiStyle === 'comfyui' ? 'comfyui' : isChatCustomProvider(p) ? 'chat' : isVideoCustomProvider(p) ? 'video' : (p.extraParams?.providerConfigVersion === 'new-v1' ? 'new' : 'old'));
  }, [providers, onRequestAdd]);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-text-dark">我的配置</h2>
          <p className="mt-1 text-[13px] text-text-muted">
            已保存的{t('settings.imageProviderConfig.preset')}、{t('settings.imageProviderConfig.fullCustom')}和视频配置。查看配置可回到对应表单继续编辑；查看模型展示该配置支持的模型与能力。
          </p>
        </div>
        <UiButton variant="primary" icon={<Plus />} onClick={() => onRequestAdd?.('new')}>
          新增配置
        </UiButton>
      </div>

      <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
        {providers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-8 text-center">
            <div className="text-[13px] text-text-muted">还没有保存任何配置</div>
            <UiButton variant="secondary" size="sm" icon={<Plus />} className="mt-3" onClick={() => onRequestAdd?.('new')}>
              去「添加供应商」新建
            </UiButton>
          </div>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="rounded-xl border border-[var(--line)] bg-surface p-4">
              {(() => {
                const savedTestResult = providerTestResults[p.id];
                const isTestingThisProvider = testingProviderId === p.id;
                const isChat = isChatCustomProvider(p);
                const isVideo = isVideoCustomProvider(p);
                const kind = providerKindLabel(p);
                return (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-[13px] font-medium text-text-dark">{p.label}</div>
                    <UiBadge tone={kind.tone}>
                      {kind.labelKey ? t(kind.labelKey) : kind.label}
                    </UiBadge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[12px] text-text-muted">{p.baseUrl || '(未填 baseUrl)'}</div>
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    接口：{p.apiStyle} · 请求 {isChat ? 'JSON 对话' : formatBodyModeLabel(resolveCustomProviderBodyMode(p))} · 模型 {p.models.length} 个
                    {!isChat && <> · {p.supportsWebSearch ? '支持联网' : '不支持联网'}</>}
                  </div>
                  {p.note && <div className="mt-1 truncate text-[11px] italic text-text-subtle">ⓘ {p.note}</div>}
                  {savedTestResult && (
                    <div className={`mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                      savedTestResult.ok
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-danger/30 bg-danger/10 text-danger'
                    }`}>
                      {savedTestResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                      {savedTestResult.ok ? '连通正常' : (savedTestResult.errorMessage ?? '连通失败')}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <UiButton
                    variant="secondary"
                    size="sm"
                    icon={<Plug />}
                    loading={isTestingThisProvider}
                    onClick={() => { void handleTestSavedProvider(p); }}
                    disabled={(isVideo && p.apiStyle !== 'comfyui') || isTestingThisProvider || (!hasCustomProviderCredential(p)) || !p.baseUrl.trim()}
                    title={p.apiStyle === 'comfyui' ? '只读检查 ComfyUI 服务，不提交生成任务' : isVideo ? '视频配置暂不走图片连通测试' : isChat ? '用这条已保存配置发一次文本对话测试请求' : '用这条已保存配置发一次测试请求'}
                  >
                    {isTestingThisProvider ? '测试中' : '测试连通'}
                  </UiButton>
                  <UiButton
                    variant="secondary"
                    size="sm"
                    icon={<Pencil />}
                    onClick={() => handleEdit(p.id)}
                    title="查看并编辑配置"
                  >
                    查看配置
                  </UiButton>
                  <UiButton
                    variant="secondary"
                    size="sm"
                    icon={<List />}
                    onClick={() => setModelsDialogFor(p.id)}
                    title="查看包含的模型与支持能力"
                  >
                    查看模型
                  </UiButton>
                  <UiIconButton
                    size="sm"
                    onClick={() => removeProvider(p.id)}
                    aria-label="删除"
                    title="删除"
                  >
                    <Trash2 />
                  </UiIconButton>
                </div>
              </div>
                );
              })()}
            </div>
          ))
        )}
      </div>

      {/* "查看模型" popup */}
      {modelsDialogProvider && (
        <UiModal
          isOpen
          title={`${modelsDialogProvider.label} · 模型与能力`}
          onClose={() => setModelsDialogFor(null)}
          widthClassName="w-[min(480px,90vw)]"
          containerClassName="z-100"
        >
          <div className="space-y-3 text-[12px]">
            <div>
              <div className="mb-1 text-text-muted">模型列表 ({modelsDialogProvider.models.length})</div>
              {modelsDialogProvider.models.length === 0 ? (
                <div className="text-text-subtle">（该配置未列出模型）</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {modelsDialogProvider.models.map((m) => (
                    <span key={m} className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 font-mono text-[11px] text-text-dark">{m}</span>
                  ))}
                </div>
              )}
            </div>
            <div>
              {isChatCustomProvider(modelsDialogProvider) ? (
                <>
                  <div className="mb-1 text-text-muted">对话模型元数据</div>
                  <div className="space-y-1.5">
                    {modelsDialogProvider.models.length === 0 ? (
                      <div className="text-text-subtle">（暂无模型元数据）</div>
                    ) : modelsDialogProvider.models.map((modelId) => {
                      const metadata = modelsDialogProvider.modelMetadata?.[modelId] ?? {};
                      return (
                        <div key={modelId} className="rounded-md bg-[var(--field-bg)] px-2 py-1.5 text-[11px] text-text-dark">
                          <div className="font-mono">{modelId}</div>
                          <div className="mt-1 flex flex-wrap gap-1 text-text-muted">
                            <span className="rounded-md border border-[var(--line)] px-1.5 py-0.5">
                              {metadata.supportsMultimodal ? '支持多模态' : '纯文本'}
                            </span>
                            <span className="rounded-md border border-[var(--line)] px-1.5 py-0.5">
                              上下文 {metadata.contextWindow ?? '未填'}
                            </span>
                            <span className="rounded-md border border-[var(--line)] px-1.5 py-0.5">
                              最大输出 {metadata.maxOutputTokens ?? '未填'}
                            </span>
                          </div>
                          {metadata.description && (
                            <div className="mt-1 text-text-muted">{metadata.description}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : isVideoCustomProvider(modelsDialogProvider) ? (
                <>
                  <div className="mb-1 text-text-muted">支持秒数</div>
                  <div className="flex flex-wrap gap-1">
                    {modelsDialogDurations.map((duration) => (
                      <span key={duration} className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 text-[11px] text-text-dark">{duration}s</span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-1 text-text-muted">生图比例</div>
                  <div className="flex flex-wrap gap-1">
                    {modelsDialogRatios.map((r) => (
                      <span key={r} className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 text-[11px] text-text-dark">{r}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
            {isVideoCustomProvider(modelsDialogProvider) && (
              <div>
                <div className="mb-1 text-text-muted">支持分辨率</div>
                <div className="flex flex-wrap gap-1">
                  {(modelsDialogProvider.supportedResolutions ?? []).map((resolution) => (
                    <span key={resolution} className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 text-[11px] text-text-dark">{resolution}</span>
                  ))}
                </div>
              </div>
            )}
            {!isChatCustomProvider(modelsDialogProvider) && (
              <div>
                <div className="mb-1 text-text-muted">联网搜索</div>
                <div className="text-text-dark">{modelsDialogProvider.supportsWebSearch ? '支持 ✓' : '不支持'}</div>
              </div>
            )}
            <div>
              <div className="mb-1 text-text-muted">接口风格</div>
              <code className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 text-[11px] text-text-dark">{modelsDialogProvider.apiStyle}</code>
            </div>
            <div>
              <div className="mb-1 text-text-muted">请求格式</div>
              <code className="rounded-md bg-[var(--field-bg)] px-2 py-0.5 text-[11px] text-text-dark">
                {isChatCustomProvider(modelsDialogProvider) ? 'JSON 对话' : formatBodyModeLabel(resolveCustomProviderBodyMode(modelsDialogProvider))}
              </code>
            </div>
            {formatImportPlanPreview(modelsDialogProvider.extraParams) && (
              <details className="rounded-xl border border-[var(--line)] bg-surface p-3">
                <summary className="cursor-pointer text-[12px] text-text-dark">导入识别计划</summary>
                <pre className="ui-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-4 text-text-muted">
                  {formatImportPlanPreview(modelsDialogProvider.extraParams)}
                </pre>
              </details>
            )}
          </div>
        </UiModal>
      )}
    </>
  );
});

CustomProvidersSection.displayName = 'CustomProvidersSection';
