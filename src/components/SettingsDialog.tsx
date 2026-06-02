import { useState, useCallback, useEffect, useMemo } from 'react';
import { X, FolderOpen, Plus, Trash2, Copy, CheckCircle2, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore, type PanoramaControlSensitivity } from '@/stores/settingsStore';
import { UiCheckbox, UiSelect } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { listModelProviders } from '@/features/canvas/models';
import type { SettingsCategory } from '@/features/settings/settingsEvents';
import { CustomProvidersSection } from '@/components/settings/CustomProvidersSection';
import { DreaminaSection } from '@/components/settings/DreaminaSection';
import { PromptManagementSection } from '@/components/settings/PromptManagementSection';
import { PromptPresetsSection } from '@/components/settings/PromptPresetsSection';
import { CUSTOM_PROVIDER_TUTORIAL_PROMPT } from '@/stores/customProvidersStore';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  onCheckUpdate?: () => Promise<'has-update' | 'up-to-date' | 'failed'>;
}

interface SettingsCheckboxCardProps {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const _UNUSED_PROVIDER_URLS_KEPT_FOR_FUTURE_USE: Record<string, string> = {
  ppio: 'https://ppio.com/user/register?invited_by=WGY0DZ',
  grsai: 'https://grsai.com',
  kie: 'https://kie.ai?ref=eef20ef0b0595cad227d45b29c635f6c',
  fal: 'https://fal.ai',
  ppio_keys: 'https://ppio.com/settings/key-management',
  grsai_keys: 'https://grsai.com/zh/dashboard/api-keys',
  kie_keys: 'https://kie.ai/api-key',
  fal_keys: 'https://fal.ai/dashboard/keys',
};
void _UNUSED_PROVIDER_URLS_KEPT_FOR_FUTURE_USE;

const PROJECT_REPOSITORY_URL = 'https://github.com/ganbo-gab/open-storyboard-canvas';
const ORIGINAL_PROJECT_URL = 'https://github.com/henjicc/Storyboard-Copilot';

function SettingsCheckboxCard({
  title,
  description,
  checked,
  onCheckedChange,
}: SettingsCheckboxCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onCheckedChange(!checked)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onCheckedChange(!checked);
        }
      }}
      className="w-full rounded-lg border border-border-dark bg-bg-dark p-4 text-left transition-colors hover:border-[rgba(255,255,255,0.2)]"
    >
      <div className="flex items-start gap-3">
        <UiCheckbox
          checked={checked}
          onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0"
        />
        <div>
          <h3 className="text-sm font-medium text-text-dark">{title}</h3>
          <p className="mt-1 text-xs text-text-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({
  isOpen,
  onClose,
  initialCategory = 'general',
  onCheckUpdate,
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const {
    apiKeys,
    grsaiNanoBananaProModel,
    downloadPresetPaths,
    useUploadFilenameAsNodeTitle,
    storyboardGenKeepStyleConsistent,
    storyboardGenDisableTextInImage,
    storyboardGenAutoInferEmptyFrame,
    ignoreAtTagWhenCopyingAndGenerating,
    appendParameterConstraintsToPrompt,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    useLegacyPanoramaControlDirection,
    panoramaControlSensitivity,
    uiRadiusPreset,
    themeTonePreset,
    accentColor,
    canvasEdgeRoutingMode,
    autoCheckAppUpdateOnLaunch,
    enableUpdateDialog,
    setProviderApiKey,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setAppendParameterConstraintsToPrompt,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setUseLegacyPanoramaControlDirection,
    setPanoramaControlSensitivity,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
  } = useSettingsStore();
  const providers = useMemo(() => {
    // Per product decision: only GRSAI is a built-in provider for now. The
    // others are exposed via the new "Custom provider" and "Dreamina" sections,
    // so we filter them out of the classic provider list here.
    const visibleIds = new Set(['grsai']);
    return listModelProviders().slice().filter((p) => visibleIds.has(p.id));
  }, []);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [appVersion, setAppVersion] = useState<string>('');
  const [localApiKeys, setLocalApiKeys] = useState<Record<string, string>>(apiKeys);
  const [localGrsaiNanoBananaProModel, setLocalGrsaiNanoBananaProModel] = useState(
    grsaiNanoBananaProModel
  );
  const [localDownloadPathInput, setLocalDownloadPathInput] = useState('');
  const [localDownloadPresetPaths, setLocalDownloadPresetPaths] = useState(downloadPresetPaths);
  const [localUseUploadFilenameAsNodeTitle, setLocalUseUploadFilenameAsNodeTitle] = useState(
    useUploadFilenameAsNodeTitle
  );
  const [localStoryboardGenKeepStyleConsistent, setLocalStoryboardGenKeepStyleConsistent] =
    useState(storyboardGenKeepStyleConsistent);
  const [localStoryboardGenDisableTextInImage, setLocalStoryboardGenDisableTextInImage] = useState(
    storyboardGenDisableTextInImage
  );
  const [localStoryboardGenAutoInferEmptyFrame, setLocalStoryboardGenAutoInferEmptyFrame] = useState(
    storyboardGenAutoInferEmptyFrame
  );
  const [localIgnoreAtTagWhenCopyingAndGenerating, setLocalIgnoreAtTagWhenCopyingAndGenerating] =
    useState(ignoreAtTagWhenCopyingAndGenerating);
  const [localAppendParameterConstraintsToPrompt, setLocalAppendParameterConstraintsToPrompt] =
    useState(appendParameterConstraintsToPrompt);
  const [localEnableStoryboardGenGridPreviewShortcut, setLocalEnableStoryboardGenGridPreviewShortcut] =
    useState(enableStoryboardGenGridPreviewShortcut);
  const [localShowStoryboardGenAdvancedRatioControls, setLocalShowStoryboardGenAdvancedRatioControls] =
    useState(showStoryboardGenAdvancedRatioControls);
  const [localUseLegacyPanoramaControlDirection, setLocalUseLegacyPanoramaControlDirection] =
    useState(useLegacyPanoramaControlDirection);
  const [localPanoramaControlSensitivity, setLocalPanoramaControlSensitivity] =
    useState<PanoramaControlSensitivity>(panoramaControlSensitivity);
  const [localUiRadiusPreset, setLocalUiRadiusPreset] = useState(uiRadiusPreset);
  const [localThemeTonePreset, setLocalThemeTonePreset] = useState(themeTonePreset);
  const [localAccentColor, setLocalAccentColor] = useState(accentColor);
  const [localCanvasEdgeRoutingMode, setLocalCanvasEdgeRoutingMode] = useState(canvasEdgeRoutingMode);
  const [localAutoCheckAppUpdateOnLaunch, setLocalAutoCheckAppUpdateOnLaunch] = useState(
    autoCheckAppUpdateOnLaunch
  );
  const [localEnableUpdateDialog, setLocalEnableUpdateDialog] = useState(enableUpdateDialog);
  const [checkUpdateStatus, setCheckUpdateStatus] = useState<'' | 'checking' | 'has-update' | 'up-to-date' | 'failed'>('');
  const [tutorialPromptCopied, setTutorialPromptCopied] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  useEffect(() => {
    let mounted = true;
    const loadAppVersion = async () => {
      try {
        const version = await getVersion();
        if (mounted) {
          setAppVersion(version);
        }
      } catch {
        if (mounted) {
          setAppVersion('');
        }
      }
    };
    void loadAppVersion();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setLocalApiKeys(apiKeys);
    setLocalDownloadPresetPaths(downloadPresetPaths);
    setLocalGrsaiNanoBananaProModel(grsaiNanoBananaProModel);
    setLocalUseUploadFilenameAsNodeTitle(useUploadFilenameAsNodeTitle);
    setLocalStoryboardGenKeepStyleConsistent(storyboardGenKeepStyleConsistent);
    setLocalStoryboardGenDisableTextInImage(storyboardGenDisableTextInImage);
    setLocalStoryboardGenAutoInferEmptyFrame(storyboardGenAutoInferEmptyFrame);
    setLocalIgnoreAtTagWhenCopyingAndGenerating(ignoreAtTagWhenCopyingAndGenerating);
    setLocalAppendParameterConstraintsToPrompt(appendParameterConstraintsToPrompt);
    setLocalEnableStoryboardGenGridPreviewShortcut(enableStoryboardGenGridPreviewShortcut);
    setLocalShowStoryboardGenAdvancedRatioControls(showStoryboardGenAdvancedRatioControls);
    setLocalUseLegacyPanoramaControlDirection(useLegacyPanoramaControlDirection);
    setLocalPanoramaControlSensitivity(panoramaControlSensitivity);
    setLocalUiRadiusPreset(uiRadiusPreset);
    setLocalThemeTonePreset(themeTonePreset);
    setLocalAccentColor(accentColor);
    setLocalCanvasEdgeRoutingMode(canvasEdgeRoutingMode);
    setLocalAutoCheckAppUpdateOnLaunch(autoCheckAppUpdateOnLaunch);
    setLocalEnableUpdateDialog(enableUpdateDialog);
    setCheckUpdateStatus('');
    setLocalDownloadPathInput('');
  }, [
    isOpen,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveCategory(initialCategory);
  }, [initialCategory, isOpen]);

  const handleSave = useCallback(() => {
    providers.forEach((provider) => {
      setProviderApiKey(provider.id, localApiKeys[provider.id] ?? '');
    });
    setGrsaiNanoBananaProModel(localGrsaiNanoBananaProModel);
    setDownloadPresetPaths(localDownloadPresetPaths);
    setUseUploadFilenameAsNodeTitle(localUseUploadFilenameAsNodeTitle);
    setStoryboardGenKeepStyleConsistent(localStoryboardGenKeepStyleConsistent);
    setStoryboardGenDisableTextInImage(localStoryboardGenDisableTextInImage);
    setStoryboardGenAutoInferEmptyFrame(localStoryboardGenAutoInferEmptyFrame);
    setIgnoreAtTagWhenCopyingAndGenerating(localIgnoreAtTagWhenCopyingAndGenerating);
    setAppendParameterConstraintsToPrompt(localAppendParameterConstraintsToPrompt);
    setEnableStoryboardGenGridPreviewShortcut(localEnableStoryboardGenGridPreviewShortcut);
    setShowStoryboardGenAdvancedRatioControls(localShowStoryboardGenAdvancedRatioControls);
    setUseLegacyPanoramaControlDirection(localUseLegacyPanoramaControlDirection);
    setPanoramaControlSensitivity(localPanoramaControlSensitivity);
    setUiRadiusPreset(localUiRadiusPreset);
    setThemeTonePreset(localThemeTonePreset);
    setAccentColor(localAccentColor);
    setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
    setAutoCheckAppUpdateOnLaunch(localAutoCheckAppUpdateOnLaunch);
    setEnableUpdateDialog(localEnableUpdateDialog);
    setSettingsSaved(true);
    window.setTimeout(() => setSettingsSaved(false), 1500);
  }, [
    localApiKeys,
    localDownloadPresetPaths,
    localGrsaiNanoBananaProModel,
    localUseUploadFilenameAsNodeTitle,
    localStoryboardGenKeepStyleConsistent,
    localStoryboardGenDisableTextInImage,
    localStoryboardGenAutoInferEmptyFrame,
    localIgnoreAtTagWhenCopyingAndGenerating,
    localAppendParameterConstraintsToPrompt,
    localEnableStoryboardGenGridPreviewShortcut,
    localShowStoryboardGenAdvancedRatioControls,
    localUseLegacyPanoramaControlDirection,
    localPanoramaControlSensitivity,
    localUiRadiusPreset,
    localThemeTonePreset,
    localAccentColor,
    localCanvasEdgeRoutingMode,
    localAutoCheckAppUpdateOnLaunch,
    localEnableUpdateDialog,
    providers,
    setProviderApiKey,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setAppendParameterConstraintsToPrompt,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setUseLegacyPanoramaControlDirection,
    setPanoramaControlSensitivity,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
  ]);

  const handleOpenRepository = useCallback(() => {
    void openUrl(PROJECT_REPOSITORY_URL);
  }, []);

  const handleOpenOriginalProject = useCallback(() => {
    void openUrl(ORIGINAL_PROJECT_URL);
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (!onCheckUpdate) {
      return;
    }

    setCheckUpdateStatus('checking');
    const status = await onCheckUpdate();
    setCheckUpdateStatus(status);
  }, [onCheckUpdate]);

  const handlePickDownloadPath = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) {
        return;
      }
      setLocalDownloadPresetPaths((previous) => {
        if (previous.includes(selected)) {
          return previous;
        }
        return [...previous, selected].slice(0, 8);
      });
    } catch (error) {
      console.error('Failed to pick download path', error);
    }
  }, []);

  const handleAddDownloadPathFromInput = useCallback(() => {
    const next = localDownloadPathInput.trim();
    if (!next) {
      return;
    }
    setLocalDownloadPresetPaths((previous) => {
      if (previous.includes(next)) {
        return previous;
      }
      return [...previous, next].slice(0, 8);
    });
    setLocalDownloadPathInput('');
  }, [localDownloadPathInput]);

  const handleRemoveDownloadPath = useCallback((path: string) => {
    setLocalDownloadPresetPaths((previous) => previous.filter((value) => value !== path));
  }, []);

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/90 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div className="relative w-[min(96vw,1120px)]">
        <div
          className={`relative mx-auto h-[min(86vh,760px)] w-full overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'} flex`}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 hover:bg-bg-dark rounded transition-colors z-10"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>

          {/* Sidebar */}
          <div className="ui-scrollbar w-[180px] bg-bg-dark border-r border-border-dark flex flex-col overflow-y-auto">
            <div className="px-4 py-4">
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('settings.title')}
              </span>
            </div>

            <nav className="flex-1">
              <button
                onClick={() => setActiveCategory('general')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'general'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.general')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('providers')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'providers'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">添加服务商</span>
              </button>

              <button
                onClick={() => setActiveCategory('customProviders')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'customProviders'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">我的配置</span>
              </button>

              <button
                onClick={() => setActiveCategory('dreamina')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'dreamina'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">Dreamina 即梦</span>
              </button>

              <button
                onClick={() => setActiveCategory('promptManagement')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'promptManagement'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.promptManagement.title')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('promptPresets')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'promptPresets'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.promptPresets.title')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('appearance')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'appearance'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.appearance')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('about')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'about'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.about')}</span>
              </button>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {activeCategory === 'customProviders' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-5">
                  <CustomProvidersSection
                    mode="list"
                    onRequestAdd={() => setActiveCategory('providers')}
                  />
                </div>
              </div>
            )}

            {activeCategory === 'dreamina' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-5">
                  <div className="grid grid-cols-[1fr_280px] gap-4">
                    <DreaminaSection />
                    {/* Right-side tips column — mirrors the 添加服务商 layout. */}
                    <div className="space-y-3">
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                        <div className="text-xs font-medium text-text-dark">提示 · 即梦</div>
                        <ul className="mt-2 space-y-1.5 text-[11px] text-text-muted leading-5 list-disc pl-4">
                          <li>即梦通过本地 CLI + 本地登录态调用，不需要贴 API Key。</li>
                          <li>若「检测登录」显示<strong className="text-emerald-400"> 已登录 · 网络不稳定</strong>，说明本地 session 有效，只是积分接口暂时不可达，可直接使用生图。</li>
                          <li>若显示未登录：先运行 <code className="rounded bg-surface-dark px-1">dreamina login</code>，登录完回到这里再检测一次。</li>
                          <li>如果检测按钮始终报「未找到 CLI」，请在终端里 <code className="rounded bg-surface-dark px-1">which dreamina</code> 确认二进制真的在 PATH 中；Tauri 可能继承不到登录 shell 的 PATH。</li>
                        </ul>
                      </div>

                      <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-3">
                        <div className="text-[11px] text-text-muted leading-5">
                          ⓘ 即梦生图速度受账号队列影响，首次生成 / 高峰期可能等 30～90s 属正常现象，背景有在跑。
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeCategory === 'promptManagement' && <PromptManagementSection />}

            {activeCategory === 'promptPresets' && <PromptPresetsSection />}

            {activeCategory === 'providers' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-5">
                  <div className="grid grid-cols-[1fr_280px] gap-4">
                    <div className="space-y-5 min-w-0">
                      {/* Top action: copy tutorial prompt — replaces the
                          previously visible GRSAI built-in key card at this
                          position. */}
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-4 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-text-dark">不知道从哪儿开始？</div>
                          <p className="text-xs text-text-muted mt-0.5 leading-5">
                            点右侧按钮复制一份「给 AI 用的教程提示词」，粘贴到任意 AI，把服务商 API 文档也发给 AI，它会返回可直接导入的 JSON。
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(CUSTOM_PROVIDER_TUTORIAL_PROMPT);
                              setTutorialPromptCopied(true);
                              setTimeout(() => setTutorialPromptCopied(false), 1800);
                            } catch { /* ignore */ }
                          }}
                          className="shrink-0 inline-flex items-center gap-1 rounded-md bg-accent/20 px-3 py-2 text-xs text-accent hover:bg-accent/30"
                        >
                          {tutorialPromptCopied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          {tutorialPromptCopied ? '已复制' : '复制教程提示词'}
                        </button>
                      </div>

                      {/* Custom provider add flow (form + one-click import) */}
                      <CustomProvidersSection mode="add" />
                    </div>

                    {/* Right-side tips column — mirrors the Dreamina layout. */}
                    <div className="space-y-3">
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                        <div className="text-xs font-medium text-text-dark">{t('settings.customProviderHelp.title')}</div>
                        <ol className="mt-2 space-y-1.5 text-[11px] text-text-muted leading-5 list-decimal pl-4">
                          <li>{t('settings.customProviderHelp.step1')}</li>
                          <li>{t('settings.customProviderHelp.step2')}</li>
                          <li>{t('settings.customProviderHelp.step3')}</li>
                          <li>{t('settings.customProviderHelp.step4')}</li>
                        </ol>
                      </div>

                      <div className="rounded-lg border border-border-dark bg-bg-dark p-3 min-w-0">
                        <div className="text-xs font-medium text-text-dark">字段说明 · 关键</div>
                        <ul className="mt-2 space-y-1.5 text-[11px] text-text-muted leading-5 list-disc pl-4">
                          <li>
                            <strong className="text-text-dark">生图接口路径</strong>：各家 API 路径不同。留空时会用 apiStyle 的默认路径。常见有：
                            <div className="mt-1 space-y-0.5">
                              <div><code className="rounded bg-surface-dark px-1 break-all">/images/generations</code></div>
                              <div><code className="rounded bg-surface-dark px-1 break-all">/create</code></div>
                              <div><code className="rounded bg-surface-dark px-1 break-all">/v1/chat/completions</code></div>
                            </div>
                          </li>
                          <li><strong className="text-text-dark">API 风格</strong>：决定请求体格式，如 openai-compatible、fal 等。</li>
                          <li><strong className="text-text-dark">响应格式</strong>：决定怎么从返回 JSON 里挑出图片 URL。</li>
                          <li><strong className="text-text-dark">supportsWebSearch</strong>：勾上以后，这个服务商在面板「参数 ⚙」里会多一个「启用联网搜索」开关，生图时会把 <code className="rounded bg-surface-dark px-1">web_search: true</code> 加到请求里。</li>
                          <li><strong className="text-text-dark">支持比例</strong>：点击智能芯片使用模型默认；点 <strong>+</strong> 自定义；自定义比例右上角 × 可删除。</li>
                        </ul>
                      </div>

                      <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                        <div className="text-xs font-medium text-text-dark">预设覆盖</div>
                        <div className="mt-2 text-[11px] leading-5 text-text-muted">
                          已内置 OpenAI Images、OpenAI 兼容接口、Chat Completions 图像、Responses 图像工具、任务轮询、队列异步、Prediction、Multipart、签名代理等常见格式。非 OpenAI-compatible 的接口可能存在请求体或轮询差异，保存前建议点「测试连通」。
                        </div>
                      </div>

                      <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-3">
                        <div className="text-[11px] text-text-muted leading-5">
                          ⓘ 保存后这条配置会出现在左侧「我的配置」里，并出现在画布上的模型选择器里。
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={onClose}
                    className="rounded border border-border-dark px-4 py-2 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                  >
                    {t('common.close')}
                  </button>
                </div>
              </div>
            )}

            {activeCategory === 'appearance' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.appearance')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.appearanceDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.radiusPreset')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.radiusPresetDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localUiRadiusPreset}
                        onChange={(event) =>
                          setLocalUiRadiusPreset(event.target.value as typeof localUiRadiusPreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="compact">{t('settings.radiusCompact')}</option>
                        <option value="default">{t('settings.radiusDefault')}</option>
                        <option value="large">{t('settings.radiusLarge')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.themeTone')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.themeToneDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localThemeTonePreset}
                        onChange={(event) =>
                          setLocalThemeTonePreset(event.target.value as typeof localThemeTonePreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="neutral">{t('settings.toneNeutral')}</option>
                        <option value="warm">{t('settings.toneWarm')}</option>
                        <option value="cool">{t('settings.toneCool')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.edgeRoutingMode')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.edgeRoutingModeDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localCanvasEdgeRoutingMode}
                        onChange={(event) =>
                          setLocalCanvasEdgeRoutingMode(
                            event.target.value as typeof localCanvasEdgeRoutingMode
                          )
                        }
                        className="h-9 text-sm"
                      >
                        <option value="spline">{t('settings.edgeRoutingSpline')}</option>
                        <option value="orthogonal">{t('settings.edgeRoutingOrthogonal')}</option>
                        <option value="smartOrthogonal">{t('settings.edgeRoutingSmartOrthogonal')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.accentColor')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.accentColorDesc')}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="color"
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        className="h-9 w-12 rounded border border-border-dark bg-surface-dark p-1"
                      />
                      <input
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        placeholder="#3B82F6"
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => setLocalAccentColor('#3B82F6')}
                      >
                        {t('settings.resetAccentColor')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t border-border-dark px-6 py-4">
                  {settingsSaved && <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 已保存</span>}
                  <button
                    onClick={onClose}
                    className="rounded border border-border-dark px-4 py-2 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                  >
                    {t('common.close')}
                  </button>
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'general' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.general')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.generalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localStoryboardGenKeepStyleConsistent}
                    onCheckedChange={setLocalStoryboardGenKeepStyleConsistent}
                    title={t('settings.storyboardGenKeepStyleConsistent')}
                    description={t('settings.storyboardGenKeepStyleConsistentDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localIgnoreAtTagWhenCopyingAndGenerating}
                    onCheckedChange={setLocalIgnoreAtTagWhenCopyingAndGenerating}
                    title={t('settings.ignoreAtTagWhenCopyingAndGenerating')}
                    description={t('settings.ignoreAtTagWhenCopyingAndGeneratingDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localAppendParameterConstraintsToPrompt}
                    onCheckedChange={setLocalAppendParameterConstraintsToPrompt}
                    title={t('settings.appendParameterConstraintsToPrompt')}
                    description={t('settings.appendParameterConstraintsToPromptDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localUseLegacyPanoramaControlDirection}
                    onCheckedChange={setLocalUseLegacyPanoramaControlDirection}
                    title={t('settings.useLegacyPanoramaControlDirection')}
                    description={t('settings.useLegacyPanoramaControlDirectionDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.panoramaControlSensitivity')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.panoramaControlSensitivityDesc')}
                      </p>
                    </div>
                    <UiSelect
                      value={localPanoramaControlSensitivity}
                      onChange={(event) =>
                        setLocalPanoramaControlSensitivity(
                          event.target.value as PanoramaControlSensitivity
                        )
                      }
                      aria-label={t('settings.panoramaControlSensitivity')}
                    >
                      <option value="low">{t('settings.panoramaControlSensitivityLow')}</option>
                      <option value="medium">{t('settings.panoramaControlSensitivityMedium')}</option>
                      <option value="high">{t('settings.panoramaControlSensitivityHigh')}</option>
                    </UiSelect>
                  </div>

                  <SettingsCheckboxCard
                    checked={localStoryboardGenDisableTextInImage}
                    onCheckedChange={setLocalStoryboardGenDisableTextInImage}
                    title={t('settings.storyboardGenDisableTextInImage')}
                    description={t('settings.storyboardGenDisableTextInImageDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenAutoInferEmptyFrame}
                    onCheckedChange={setLocalStoryboardGenAutoInferEmptyFrame}
                    title={t('settings.storyboardGenAutoInferEmptyFrame')}
                    description={t('settings.storyboardGenAutoInferEmptyFrameDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localEnableStoryboardGenGridPreviewShortcut}
                    onCheckedChange={setLocalEnableStoryboardGenGridPreviewShortcut}
                    title={t('settings.enableStoryboardGenGridPreviewShortcut')}
                    description={t('settings.enableStoryboardGenGridPreviewShortcutDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localShowStoryboardGenAdvancedRatioControls}
                    onCheckedChange={setLocalShowStoryboardGenAdvancedRatioControls}
                    title={t('settings.showStoryboardGenAdvancedRatioControls')}
                    description={t('settings.showStoryboardGenAdvancedRatioControlsDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localUseUploadFilenameAsNodeTitle}
                    onCheckedChange={setLocalUseUploadFilenameAsNodeTitle}
                    title={t('settings.useUploadFilenameAsNodeTitle')}
                    description={t('settings.useUploadFilenameAsNodeTitleDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.downloadPresetPaths')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.downloadPresetPathsDesc')}
                      </p>
                    </div>

                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={localDownloadPathInput}
                        onChange={(event) => setLocalDownloadPathInput(event.target.value)}
                        placeholder={t('settings.downloadPathPlaceholder')}
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={handleAddDownloadPathFromInput}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('settings.addPath')}
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => {
                          void handlePickDownloadPath();
                        }}
                      >
                        <FolderOpen className="mr-1 h-3.5 w-3.5" />
                        {t('settings.chooseFolder')}
                      </button>
                    </div>

                    <div className="space-y-1">
                      {localDownloadPresetPaths.length > 0 ? (
                        localDownloadPresetPaths.map((path) => (
                          <div
                            key={path}
                            className="flex items-center gap-2 rounded border border-border-dark bg-surface-dark px-2 py-1.5"
                          >
                            <span className="truncate text-xs text-text-dark">{path}</span>
                            <button
                              type="button"
                              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                              onClick={() => handleRemoveDownloadPath(path)}
                              title={t('common.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-text-muted">{t('settings.noDownloadPresetPaths')}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t border-border-dark px-6 py-4">
                  {settingsSaved && <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 已保存</span>}
                  <button
                    onClick={onClose}
                    className="rounded border border-border-dark px-4 py-2 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                  >
                    {t('common.close')}
                  </button>
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'about' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.about')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.aboutDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <div className="flex items-start gap-4">
                      <img
                        src="/app-icon.png"
                        alt={t('settings.aboutAppName')}
                        className="h-14 w-14 rounded-lg border border-border-dark object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-semibold text-text-dark">
                          {t('settings.aboutAppName')}
                        </div>
                        <p className="mt-1 text-sm text-text-muted">
                          {t('settings.aboutIntro')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-2 text-sm">
                    <p className="text-text-dark">
                      {t('settings.aboutVersionLabel')}: <span className="text-text-muted">{appVersion || t('settings.aboutVersionUnknown')}</span>
                    </p>
                    <p className="text-text-dark">
                      {t('settings.aboutAuthorLabel')}: <span className="text-text-muted">{t('settings.aboutAuthor')}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-text-dark">
                      <span>{t('settings.aboutRepositoryLabel')}:</span>
                      <button
                        type="button"
                        onClick={handleOpenRepository}
                        className="inline-flex items-center gap-1 break-all text-left text-accent hover:underline"
                      >
                        <span>{t('settings.aboutRepositoryUrl')}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </div>
                    <p className="text-text-dark">
                      {t('settings.aboutOriginalAuthorLabel')}: <span className="text-text-muted">{t('settings.aboutOriginalAuthor')}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-text-dark">
                      <span>{t('settings.aboutOriginalProjectLabel')}:</span>
                      <button
                        type="button"
                        onClick={handleOpenOriginalProject}
                        className="inline-flex items-center gap-1 break-all text-left text-accent hover:underline"
                      >
                        <span>{t('settings.aboutOriginalProjectUrl')}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </div>
                    <p className="text-xs leading-relaxed text-text-muted">
                      {t('settings.aboutOriginalAttributionNote')}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <SettingsCheckboxCard
                      checked={localAutoCheckAppUpdateOnLaunch}
                      onCheckedChange={setLocalAutoCheckAppUpdateOnLaunch}
                      title={t('settings.autoCheckUpdateOnLaunch')}
                      description={t('settings.autoCheckUpdateOnLaunchDesc')}
                    />
                    <SettingsCheckboxCard
                      checked={localEnableUpdateDialog}
                      onCheckedChange={setLocalEnableUpdateDialog}
                      title={t('settings.enableUpdateDialog')}
                      description={t('settings.enableUpdateDialogDesc')}
                    />
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          void handleCheckUpdate();
                        }}
                        className="rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={checkUpdateStatus === 'checking'}
                      >
                        {checkUpdateStatus === 'checking'
                          ? t('settings.checkingUpdate')
                          : t('settings.checkUpdateNow')}
                      </button>
                      {checkUpdateStatus !== '' && (
                        <p className="mt-2 text-xs text-text-muted">
                          {checkUpdateStatus === 'has-update' && t('settings.checkUpdateHasUpdate')}
                          {checkUpdateStatus === 'up-to-date' && t('settings.checkUpdateUpToDate')}
                          {checkUpdateStatus === 'failed' && t('settings.checkUpdateFailed')}
                          {checkUpdateStatus === 'checking' && t('settings.checkingUpdate')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  {settingsSaved && <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 已保存</span>}
                  <div className="flex gap-2">
                    <button
                      onClick={onClose}
                      className="rounded border border-border-dark px-4 py-2 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                    >
                      {t('common.close')}
                    </button>
                    <button
                      onClick={handleSave}
                      className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                    >
                      {t('common.save')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
