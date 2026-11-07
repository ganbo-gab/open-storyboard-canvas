import { SidebarResizeHandle, useSidebarWidth } from '@/components/ui/SidebarResizeHandle';
import { customHttpRequest } from '@/commands/ai';
import { ImageHostSection } from '@/components/settings/ImageHostSection';
import { imageHostConfigurationError } from '@/features/settings/imageHostSettings';
import { WorkspaceLayoutSettings } from '@/features/settings/WorkspaceLayoutSettings';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { FolderOpen, Plus, Trash2, CheckCircle2, ExternalLink, Network, ArrowLeft, Settings2, Keyboard, Plug, Workflow, Image, Sparkles, Palette, Database, Info, Bot, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  DEFAULT_IMAGE_HOST_SETTINGS,
  useSettingsStore,
  type CanvasLeftDragMode,
  type CanvasWheelMode,
  type ImageHostSettings,
  type GenerationNetworkRoute,
  type PanoramaControlSensitivity,
} from '@/stores/settingsStore';
import { UiButton, UiCheckbox, UiIconButton, UiInput, UiSegmented, UiSelect, UiSlider } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { listModelProviders } from '@/features/canvas/models';
import type { SettingsCategory } from '@/features/settings/settingsEvents';
import { ComfyUISettingsSection } from '@/components/settings/ComfyUISettingsSection';
import { ChannelSettingsPage } from '@/features/settings/channels/ChannelSettingsPage';
import { AgnesSettingsSection } from '@/components/settings/AgnesSettingsSection';
import { DreaminaSection } from '@/components/settings/DreaminaSection';
import { PromptManagementSection } from '@/components/settings/PromptManagementSection';
import { PromptPresetsSection } from '@/components/settings/PromptPresetsSection';
import { SettingsPortabilitySection } from '@/components/settings/SettingsPortabilitySection';
import { ExternalAgentConnectionPanel } from '@/features/canvas/agent/ui/ExternalAgentConnectionPanel';
import { buildExternalCanvasMcpManifest } from '@/features/canvas/agent/application/externalAgentToolManifest';
import { useProjectStore } from '@/stores/projectStore';
import { AppearanceThemeSettings } from '@/features/theme/AppearanceThemeSettings';

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

const PROJECT_REPOSITORY_URL = 'https://github.com/ganbo-gab/open-storyboard-canvas';
const ORIGINAL_PROJECT_URL = 'https://github.com/henjicc/Storyboard-Copilot';

const SETTINGS_NAVIGATION = [
  [
    { id: 'providersAdd', label: 'ui.channels.market.nav', icon: Plug },
    { id: 'comfyui', label: 'ComfyUI', icon: Workflow },
    { id: 'dreamina', label: 'settings.dreamina.title', icon: Sparkles },
    { id: 'agnes', label: 'Agnes', icon: Image },
  ],
  [
    { id: 'general', label: 'settings.general', icon: Settings2 },
    { id: 'keybindings', label: 'settings.keybindings', icon: Keyboard },
    { id: 'appearance', label: 'settings.appearance', icon: Palette },
    { id: 'imageHosting', label: 'settings.imageHosting.title', icon: Image },
    { id: 'promptManagement', label: 'settings.promptManagement.title', icon: FileText },
    { id: 'promptPresets', label: 'settings.promptPresets.title', icon: Sparkles },
    { id: 'externalAgents', label: 'settings.externalAgents', icon: Bot },
  ],
  [
    { id: 'portability', label: 'portability.settings.nav', icon: Database },
    { id: 'about', label: 'settings.about', icon: Info },
  ],
] as const satisfies readonly (readonly { id: SettingsCategory; label: string; icon: typeof Plug }[])[];

function normalizeSettingsCategory(category: SettingsCategory): SettingsCategory {
  if (category === 'customProviders' || category === 'providers' || category === 'providersNew' || category === 'providersOld' || category === 'providersChat') {
    return 'providersAdd';
  }
  if (category === 'textAgents') {
    return 'providersAdd';
  }
  return category;
}

function cloneImageHostSettings(settings: ImageHostSettings): ImageHostSettings {
  return { ...settings, extraHeaders: { ...settings.extraHeaders } };
}

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
      className="w-full rounded-xl border border-[var(--line)] bg-surface p-4 text-left transition-colors hover:bg-[var(--hover)]"
    >
      <div className="flex items-start gap-3">
        <UiCheckbox
          checked={checked}
          aria-label={title}
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
    collapseNodeActionToolbarByDefault,
    showNodePayloadPreview,
    generationNetworkSettings,
    enableAiTextStreaming,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    useLegacyPanoramaControlDirection,
    panoramaControlSensitivity,
    canvasLeftDragMode,
    canvasWheelMode,
    enableCanvasWasdPan,
    canvasWasdPanSensitivity,
    canvasEdgeRoutingMode,
    autoCheckAppUpdateOnLaunch,
    enableUpdateDialog,
    imageHostSettings,
    setProviderApiKey,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setAppendParameterConstraintsToPrompt,
    setCollapseNodeActionToolbarByDefault,
    setShowNodePayloadPreview,
    setGenerationNetworkSettings,
    setEnableAiTextStreaming,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setUseLegacyPanoramaControlDirection,
    setPanoramaControlSensitivity,
    setCanvasLeftDragMode,
    setCanvasWheelMode,
    setEnableCanvasWasdPan,
    setCanvasWasdPanSensitivity,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
    setImageHostSettings,
  } = useSettingsStore();
  const providers = useMemo(() => {
    // Per product decision: only GRSAI is a built-in provider for now. The
    // others are exposed via the new "Custom provider" and "Dreamina" sections,
    // so we filter them out of the classic provider list here.
    const visibleIds = new Set(['grsai']);
    return listModelProviders().slice().filter((p) => visibleIds.has(p.id));
  }, []);
  const externalAgentProject = useProjectStore((state) => state.currentProject);
  const externalAgentTools = useMemo(() => buildExternalCanvasMcpManifest([
    'canvas', 'diagnostics', 'config', 'asset-read',
  ]).tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, requiresApproval: true })), []);
  const sidebar = useSidebarWidth('settings-navigation', 240, 180, 340, 480);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(
    normalizeSettingsCategory(initialCategory)
  );
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
  const [localCollapseNodeActionToolbarByDefault, setLocalCollapseNodeActionToolbarByDefault] =
    useState(collapseNodeActionToolbarByDefault);
  const [localShowNodePayloadPreview, setLocalShowNodePayloadPreview] =
    useState(showNodePayloadPreview);
  const [localGenerationNetworkRoute, setLocalGenerationNetworkRoute] =
    useState<GenerationNetworkRoute>(generationNetworkSettings.route);
  const [localCustomProxyUrl, setLocalCustomProxyUrl] =
    useState(generationNetworkSettings.customProxyUrl);
  const [networkTestStatus, setNetworkTestStatus] = useState<'' | 'testing' | 'success' | 'failed'>('');
  const [localEnableAiTextStreaming, setLocalEnableAiTextStreaming] =
    useState(enableAiTextStreaming);
  const [localEnableStoryboardGenGridPreviewShortcut, setLocalEnableStoryboardGenGridPreviewShortcut] =
    useState(enableStoryboardGenGridPreviewShortcut);
  const [localShowStoryboardGenAdvancedRatioControls, setLocalShowStoryboardGenAdvancedRatioControls] =
    useState(showStoryboardGenAdvancedRatioControls);
  const [localUseLegacyPanoramaControlDirection, setLocalUseLegacyPanoramaControlDirection] =
    useState(useLegacyPanoramaControlDirection);
  const [localPanoramaControlSensitivity, setLocalPanoramaControlSensitivity] =
    useState<PanoramaControlSensitivity>(panoramaControlSensitivity);
  const [localCanvasLeftDragMode, setLocalCanvasLeftDragMode] =
    useState<CanvasLeftDragMode>(canvasLeftDragMode);
  const [localCanvasWheelMode, setLocalCanvasWheelMode] =
    useState<CanvasWheelMode>(canvasWheelMode);
  const [localEnableCanvasWasdPan, setLocalEnableCanvasWasdPan] =
    useState(enableCanvasWasdPan);
  const [localCanvasWasdPanSensitivity, setLocalCanvasWasdPanSensitivity] =
    useState(canvasWasdPanSensitivity);
  const [localCanvasEdgeRoutingMode, setLocalCanvasEdgeRoutingMode] = useState(canvasEdgeRoutingMode);
  const [localAutoCheckAppUpdateOnLaunch, setLocalAutoCheckAppUpdateOnLaunch] = useState(
    autoCheckAppUpdateOnLaunch
  );
  const [localEnableUpdateDialog, setLocalEnableUpdateDialog] = useState(enableUpdateDialog);
  const [localImageHostSettings, setLocalImageHostSettings] = useState<ImageHostSettings>(
    () => cloneImageHostSettings(imageHostSettings ?? DEFAULT_IMAGE_HOST_SETTINGS)
  );
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string>('');
  const [checkUpdateStatus, setCheckUpdateStatus] = useState<'' | 'checking' | 'has-update' | 'up-to-date' | 'failed'>('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);
  const requestClose = useCallback(() => {
    if (!isSavingSettings) {
      onClose();
    }
  }, [isSavingSettings, onClose]);
  const { dialogRef, onKeyDown } = useModalFocus({ isOpen: isOpen && shouldRender, onClose: requestClose });

  useEffect(() => {
    let mounted = true;
    if (!isTauri()) {
      setAppVersion('');
      return () => {
        mounted = false;
      };
    }
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
    setLocalCollapseNodeActionToolbarByDefault(collapseNodeActionToolbarByDefault);
    setLocalShowNodePayloadPreview(showNodePayloadPreview);
    setLocalGenerationNetworkRoute(generationNetworkSettings.route);
    setLocalCustomProxyUrl(generationNetworkSettings.customProxyUrl);
    setNetworkTestStatus('');
    setLocalEnableAiTextStreaming(enableAiTextStreaming);
    setLocalEnableStoryboardGenGridPreviewShortcut(enableStoryboardGenGridPreviewShortcut);
    setLocalShowStoryboardGenAdvancedRatioControls(showStoryboardGenAdvancedRatioControls);
    setLocalUseLegacyPanoramaControlDirection(useLegacyPanoramaControlDirection);
    setLocalPanoramaControlSensitivity(panoramaControlSensitivity);
    setLocalCanvasLeftDragMode(canvasLeftDragMode);
    setLocalCanvasWheelMode(canvasWheelMode);
    setLocalEnableCanvasWasdPan(enableCanvasWasdPan);
    setLocalCanvasWasdPanSensitivity(canvasWasdPanSensitivity);
    setLocalCanvasEdgeRoutingMode(canvasEdgeRoutingMode);
    setLocalAutoCheckAppUpdateOnLaunch(autoCheckAppUpdateOnLaunch);
    setLocalEnableUpdateDialog(enableUpdateDialog);
    setLocalImageHostSettings(cloneImageHostSettings(imageHostSettings ?? DEFAULT_IMAGE_HOST_SETTINGS));
    setSettingsSaveError('');
    setIsSavingSettings(false);
    setCheckUpdateStatus('');
    setLocalDownloadPathInput('');
  }, [
    isOpen,
  ]);

  const handleTestGenerationNetwork = useCallback(async () => {
    setNetworkTestStatus('testing');
    try {
      const response = await customHttpRequest({
        url: 'https://www.gstatic.com/generate_204',
        method: 'GET',
        timeoutMs: 12_000,
        networkRoute: localGenerationNetworkRoute,
        customProxyUrl: localGenerationNetworkRoute === 'custom-proxy'
          ? localCustomProxyUrl.trim()
          : undefined,
      });
      setNetworkTestStatus(response.status >= 200 && response.status < 400 ? 'success' : 'failed');
    } catch {
      setNetworkTestStatus('failed');
    }
  }, [localCustomProxyUrl, localGenerationNetworkRoute]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveCategory(normalizeSettingsCategory(initialCategory));
  }, [initialCategory, isOpen]);

  const handleSave = useCallback(async () => {
    if (isSavingSettings) {
      return;
    }

    setIsSavingSettings(true);
    setSettingsSaveError('');
    try {
      const nextImageHostSettings = cloneImageHostSettings(localImageHostSettings);
      const imageHostError = nextImageHostSettings.enabled ? imageHostConfigurationError(nextImageHostSettings) : null;
      if (imageHostError) throw new Error(imageHostError);
      if (localGenerationNetworkRoute === 'custom-proxy') {
        try {
          const proxyUrl = new URL(localCustomProxyUrl.trim());
          if (!/^https?:$/.test(proxyUrl.protocol) || !proxyUrl.hostname) {
            throw new Error('invalid proxy');
          }
        } catch {
          throw new Error('settings.generationNetworkInvalidProxy');
        }
      }

      // Vault-backed writes: await so a locked/failed vault surfaces in settingsSaveError instead of a silent unhandled rejection.
      await Promise.all(providers.map((provider) => setProviderApiKey(provider.id, localApiKeys[provider.id] ?? '')));
      await setImageHostSettings(nextImageHostSettings);
      setGrsaiNanoBananaProModel(localGrsaiNanoBananaProModel);
      setDownloadPresetPaths(localDownloadPresetPaths);
      setUseUploadFilenameAsNodeTitle(localUseUploadFilenameAsNodeTitle);
      setStoryboardGenKeepStyleConsistent(localStoryboardGenKeepStyleConsistent);
      setStoryboardGenDisableTextInImage(localStoryboardGenDisableTextInImage);
      setStoryboardGenAutoInferEmptyFrame(localStoryboardGenAutoInferEmptyFrame);
      setIgnoreAtTagWhenCopyingAndGenerating(localIgnoreAtTagWhenCopyingAndGenerating);
      setAppendParameterConstraintsToPrompt(localAppendParameterConstraintsToPrompt);
      setCollapseNodeActionToolbarByDefault(localCollapseNodeActionToolbarByDefault);
      setShowNodePayloadPreview(localShowNodePayloadPreview);
      setGenerationNetworkSettings({
        route: localGenerationNetworkRoute,
        customProxyUrl: localCustomProxyUrl,
      });
      setEnableAiTextStreaming(localEnableAiTextStreaming);
      setEnableStoryboardGenGridPreviewShortcut(localEnableStoryboardGenGridPreviewShortcut);
      setShowStoryboardGenAdvancedRatioControls(localShowStoryboardGenAdvancedRatioControls);
      setUseLegacyPanoramaControlDirection(localUseLegacyPanoramaControlDirection);
      setPanoramaControlSensitivity(localPanoramaControlSensitivity);
      setCanvasLeftDragMode(localCanvasLeftDragMode);
      setCanvasWheelMode(localCanvasWheelMode);
      setEnableCanvasWasdPan(localEnableCanvasWasdPan);
      setCanvasWasdPanSensitivity(localCanvasWasdPanSensitivity);
      setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
      setAutoCheckAppUpdateOnLaunch(localAutoCheckAppUpdateOnLaunch);
      setEnableUpdateDialog(localEnableUpdateDialog);
      setLocalImageHostSettings(cloneImageHostSettings(useSettingsStore.getState().imageHostSettings));
      setSettingsSaved(true);
      window.setTimeout(() => setSettingsSaved(false), 1500);
    } catch (error) {
      const messageKey = error instanceof Error ? error.message : '';
      const fallback = t('settings.imageHosting.errors.saveFailed');
      setSettingsSaveError(
        messageKey.startsWith('settings.')
          ? t(messageKey)
          : (messageKey || fallback)
      );
    } finally {
      setIsSavingSettings(false);
    }
  }, [
    isSavingSettings,
    localApiKeys,
    localDownloadPresetPaths,
    localGrsaiNanoBananaProModel,
    localUseUploadFilenameAsNodeTitle,
    localStoryboardGenKeepStyleConsistent,
    localStoryboardGenDisableTextInImage,
    localStoryboardGenAutoInferEmptyFrame,
    localIgnoreAtTagWhenCopyingAndGenerating,
    localAppendParameterConstraintsToPrompt,
    localCollapseNodeActionToolbarByDefault,
    localShowNodePayloadPreview,
    localGenerationNetworkRoute,
    localCustomProxyUrl,
    localEnableAiTextStreaming,
    localEnableStoryboardGenGridPreviewShortcut,
    localShowStoryboardGenAdvancedRatioControls,
    localUseLegacyPanoramaControlDirection,
    localPanoramaControlSensitivity,
    localCanvasLeftDragMode,
    localCanvasWheelMode,
    localEnableCanvasWasdPan,
    localCanvasWasdPanSensitivity,
    localCanvasEdgeRoutingMode,
    localAutoCheckAppUpdateOnLaunch,
    localEnableUpdateDialog,
    localImageHostSettings,
    imageHostSettings,
    providers,
    t,
    setProviderApiKey,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setAppendParameterConstraintsToPrompt,
    setCollapseNodeActionToolbarByDefault,
    setShowNodePayloadPreview,
    setGenerationNetworkSettings,
    setEnableAiTextStreaming,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setUseLegacyPanoramaControlDirection,
    setPanoramaControlSensitivity,
    setCanvasLeftDragMode,
    setCanvasWheelMode,
    setEnableCanvasWasdPan,
    setCanvasWasdPanSensitivity,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
    setImageHostSettings,
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
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[12500] bg-bg`}>
      <div className="h-full w-full">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('settings.title')}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`relative flex h-full w-full flex-col overflow-hidden bg-bg transition-[opacity,transform] duration-180 ease-out sm:flex-row ${isVisible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
        >
          <aside ref={sidebar.ref} className="relative flex w-full shrink-0 flex-col border-b border-[var(--line)] bg-surface sm:w-60 sm:border-b-0 sm:border-r">
            <div className="flex h-14 shrink-0 items-center gap-2 px-3">
              <UiIconButton onClick={requestClose} aria-label={t('common.close')} title={t('common.close')}>
                <ArrowLeft />
              </UiIconButton>
              <h1 className="text-[15px] font-semibold text-text-dark">{t('settings.title')}</h1>
            </div>
            <nav aria-label={t('settings.title')} className="ui-scrollbar flex min-h-0 flex-1 gap-1 overflow-x-auto px-3 pb-3 sm:block sm:overflow-y-auto">
              {SETTINGS_NAVIGATION.map((group, index) => (
                <div key={index} className="shrink-0 sm:mb-4">
                  <div className="hidden h-2 sm:block" />
                  {group.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className="studio-nav-item sm:mb-0.5"
                      aria-current={activeCategory === id ? 'page' : undefined}
                      onClick={() => setActiveCategory(id)}
                    >
                      <Icon />
                      <span className="whitespace-nowrap">{t(label)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <SidebarResizeHandle {...sidebar} label="设置导航宽度" />
          </aside>

          {/* Content */}
          <div className="studio-page flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {activeCategory === 'portability' && <SettingsPortabilitySection />}
            {activeCategory === 'externalAgents' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">{t('settings.externalAgents')}</h2>
                  <p className="mt-1 text-[13px] text-text-muted">{t('settings.externalAgentsDescription')}</p>
                </div>
                <div className="ui-scrollbar flex-1 overflow-y-auto p-6 space-y-4">
                  <ExternalAgentConnectionPanel projectId={externalAgentProject?.id ?? null} projectName={externalAgentProject?.name ?? null} tools={externalAgentTools} />
                </div>
              </>
            )}
            {activeCategory === 'comfyui' && <ComfyUISettingsSection />}

            {activeCategory === 'dreamina' && <DreaminaSection />}

            {activeCategory === 'promptManagement' && <PromptManagementSection />}

            {activeCategory === 'promptPresets' && <PromptPresetsSection />}


            {activeCategory === 'providersAdd' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-5">
                  <ChannelSettingsPage onClose={onClose} />
                </div>

              </div>
            )}

            {activeCategory === 'agnes' && <AgnesSettingsSection />}

            {activeCategory === 'imageHosting' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">
                    {t('settings.imageHosting.title')}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1">
                    {t('settings.imageHosting.desc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 overflow-y-auto p-6">
                  <ImageHostSection value={localImageHostSettings} onChange={(next) => { setLocalImageHostSettings(next); setSettingsSaveError(''); }} />
                  {settingsSaveError && <div role="alert" className="mt-4 rounded-lg border border-danger/25 bg-danger/8 p-3 text-xs text-danger">{settingsSaveError}</div>}
                </div>

                <div className="shrink-0 flex justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
                  {settingsSaved && <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {t('common.saved')}</span>}
                  <UiButton variant="ghost" onClick={requestClose} disabled={isSavingSettings}>
                    {t('common.close')}
                  </UiButton>
                  <UiButton
                    variant="primary"
                    onClick={() => {
                      void handleSave();
                    }}
                    loading={isSavingSettings}
                  >
                    {isSavingSettings ? t('common.saving') : t('common.save')}
                  </UiButton>
                </div>
              </>
            )}

            {activeCategory === 'appearance' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">
                    {t('settings.appearance')}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1">
                    {t('settings.appearanceDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <p className="text-xs text-text-subtle">{t('ui.theme.instantHint')}</p>
                  <AppearanceThemeSettings />
                  <WorkspaceLayoutSettings />

                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
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

                </div>

                <div className="shrink-0 flex justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
                  {settingsSaved && <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {t('common.saved')}</span>}
                  <UiButton variant="ghost" onClick={requestClose} disabled={isSavingSettings}>
                    {t('common.close')}
                  </UiButton>
                  <UiButton variant="primary" onClick={handleSave} loading={isSavingSettings}>
                    {isSavingSettings ? t('common.saving') : t('common.save')}
                  </UiButton>
                </div>
              </>
            )}

            {activeCategory === 'keybindings' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">
                    {t('settings.keybindings')}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1">
                    {t('settings.keybindingsDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
                    <div className="mb-4">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.canvasInteraction.title')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.canvasInteraction.desc')}
                      </p>
                    </div>

                    <div className="mb-4 grid gap-4 sm:grid-cols-2">
                      <fieldset className="min-w-0">
                        <legend className="mb-2 text-xs font-medium text-text-muted">
                          {t('settings.canvasInteraction.leftDrag')}
                        </legend>
                        <UiSegmented<CanvasLeftDragMode>
                          value={localCanvasLeftDragMode}
                          options={(['select', 'pan'] as const).map((mode) => ({
                            value: mode,
                            label: t(`settings.canvasInteraction.leftDragOptions.${mode}`),
                          }))}
                          onChange={setLocalCanvasLeftDragMode}
                          aria-label={t('settings.canvasInteraction.leftDrag')}
                          className="w-full"
                          size="sm"
                        />
                      </fieldset>
                      <fieldset className="min-w-0">
                        <legend className="mb-2 text-xs font-medium text-text-muted">
                          {t('settings.canvasInteraction.wheel')}
                        </legend>
                        <UiSegmented<CanvasWheelMode>
                          value={localCanvasWheelMode}
                          options={(['auto', 'zoom', 'pan'] as const).map((mode) => ({
                            value: mode,
                            label: t(`settings.canvasInteraction.wheelOptions.${mode}`),
                          }))}
                          onChange={setLocalCanvasWheelMode}
                          aria-label={t('settings.canvasInteraction.wheel')}
                          className="w-full"
                          size="sm"
                        />
                        <p className="mt-2 text-xs text-text-muted">
                          {t('settings.canvasInteraction.wheelAutoHelp')}
                        </p>
                      </fieldset>
                    </div>

                    <div className="mb-4 rounded-lg border border-[var(--line)] bg-elevated p-3">
                      <h4 className="mb-2 text-xs font-medium text-text-dark">
                        {t('settings.canvasInteraction.gesturesTitle')}
                      </h4>
                      <ul className="grid list-inside list-disc gap-x-4 gap-y-1 text-xs leading-5 text-text-muted sm:grid-cols-2">
                        {(['panButtons', 'spacePan', 'trackpad', 'modifierZoom', 'shiftSelect', 'contextMenu', 'addNode', 'tools'] as const).map((gesture) => (
                          <li key={gesture}>{t(`settings.canvasInteraction.gestures.${gesture}`)}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-lg border border-[var(--line)] bg-elevated p-3">
                      <div className="flex items-start gap-3">
                        <UiCheckbox
                          checked={localEnableCanvasWasdPan}
                          onCheckedChange={setLocalEnableCanvasWasdPan}
                          className="mt-0.5 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-medium text-text-dark">
                            {t('settings.canvasInteraction.wasdPan')}
                          </h4>
                          <p className="mt-1 text-xs text-text-muted">
                            {t('settings.canvasInteraction.wasdPanDesc')}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            <UiSlider
                              min={10}
                              max={180}
                              step={5}
                              value={localCanvasWasdPanSensitivity}
                              onChange={setLocalCanvasWasdPanSensitivity}
                              className="w-48"
                              aria-label={t('settings.canvasInteraction.wasdSensitivity')}
                            />
                            <span className="text-xs text-text-muted">
                              {t('settings.canvasInteraction.wasdSensitivityValue', {
                                value: localCanvasWasdPanSensitivity,
                              })}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 flex justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
                  {settingsSaved && <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {t('common.saved')}</span>}
                  <UiButton variant="ghost" onClick={requestClose} disabled={isSavingSettings}>
                    {t('common.close')}
                  </UiButton>
                  <UiButton variant="primary" onClick={handleSave} loading={isSavingSettings}>
                    {isSavingSettings ? t('common.saving') : t('common.save')}
                  </UiButton>
                </div>
              </>
            )}

            {activeCategory === 'general' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">
                    {t('settings.general')}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1">
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
                    checked={localCollapseNodeActionToolbarByDefault}
                    onCheckedChange={setLocalCollapseNodeActionToolbarByDefault}
                    title={t('settings.collapseNodeActionToolbarByDefault')}
                    description={t('settings.collapseNodeActionToolbarByDefaultDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localShowNodePayloadPreview}
                    onCheckedChange={setLocalShowNodePayloadPreview}
                    title={t('settings.showNodePayloadPreview')}
                    description={t('settings.showNodePayloadPreviewDesc')}
                  />

                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
                    <div className="mb-3 flex items-start gap-3">
                      <Network className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                      <div>
                        <h3 className="text-sm font-medium text-text-dark">
                          {t('settings.generationNetworkRoute')}
                        </h3>
                        <p className="mt-1 text-xs text-text-muted">
                          {t('settings.generationNetworkRouteDesc')}
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <UiSelect
                        value={localGenerationNetworkRoute}
                        onChange={(event) => {
                          setLocalGenerationNetworkRoute(event.target.value as GenerationNetworkRoute);
                          setNetworkTestStatus('');
                        }}
                        aria-label={t('settings.generationNetworkRoute')}
                      >
                        <option value="system">{t('settings.generationNetworkSystem')}</option>
                        <option value="direct">{t('settings.generationNetworkDirect')}</option>
                        <option value="custom-proxy">{t('settings.generationNetworkCustomProxy')}</option>
                      </UiSelect>
                      <UiButton
                        size="sm"
                        onClick={() => void handleTestGenerationNetwork()}
                        loading={networkTestStatus === 'testing'}
                        icon={<Network className="h-3.5 w-3.5" aria-hidden="true" />}
                      >
                        {t('settings.generationNetworkTest')}
                      </UiButton>
                    </div>
                    {localGenerationNetworkRoute === 'custom-proxy' && (
                      <UiInput
                        value={localCustomProxyUrl}
                        onChange={(event) => {
                          setLocalCustomProxyUrl(event.target.value);
                          setNetworkTestStatus('');
                        }}
                        placeholder="http://127.0.0.1:7890"
                        className="mt-3 w-full"
                        aria-label={t('settings.generationNetworkProxyUrl')}
                        spellCheck={false}
                      />
                    )}
                    {networkTestStatus === 'success' && (
                      <p role="status" className="mt-2 text-xs text-success">
                        {t('settings.generationNetworkTestSuccess')}
                      </p>
                    )}
                    {networkTestStatus === 'failed' && (
                      <p role="alert" className="mt-2 text-xs text-danger">
                        {t('settings.generationNetworkTestFailed')}
                      </p>
                    )}
                  </div>

                  <SettingsCheckboxCard
                    checked={localEnableAiTextStreaming}
                    onCheckedChange={setLocalEnableAiTextStreaming}
                    title={t('settings.enableAiTextStreaming')}
                    description={t('settings.enableAiTextStreamingDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localUseLegacyPanoramaControlDirection}
                    onCheckedChange={setLocalUseLegacyPanoramaControlDirection}
                    title={t('settings.useLegacyPanoramaControlDirection')}
                    description={t('settings.useLegacyPanoramaControlDirectionDesc')}
                  />

                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
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

                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.downloadPresetPaths')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.downloadPresetPathsDesc')}
                      </p>
                    </div>

                    <div className="mb-2 flex items-center gap-2">
                      <UiInput
                        value={localDownloadPathInput}
                        onChange={(event) => setLocalDownloadPathInput(event.target.value)}
                        placeholder={t('settings.downloadPathPlaceholder')}
                        className="min-w-0 flex-1"
                      />
                      <UiButton
                        size="sm"
                        icon={<Plus className="h-3.5 w-3.5" />}
                        onClick={handleAddDownloadPathFromInput}
                      >
                        {t('settings.addPath')}
                      </UiButton>
                      <UiButton
                        size="sm"
                        icon={<FolderOpen className="h-3.5 w-3.5" />}
                        onClick={() => {
                          void handlePickDownloadPath();
                        }}
                      >
                        {t('settings.chooseFolder')}
                      </UiButton>
                    </div>

                    <div className="space-y-1">
                      {localDownloadPresetPaths.length > 0 ? (
                        localDownloadPresetPaths.map((path) => (
                          <div
                            key={path}
                            className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line)] bg-elevated px-2 py-1.5"
                          >
                            <span className="truncate text-xs text-text-dark">{path}</span>
                            <UiIconButton
                              size="sm"
                              className="ml-auto"
                              onClick={() => handleRemoveDownloadPath(path)}
                              title={t('common.delete')}
                              aria-label={t('common.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </UiIconButton>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-text-muted">{t('settings.noDownloadPresetPaths')}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shrink-0 flex justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
                  {settingsSaved && <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {t('common.saved')}</span>}
                  <UiButton variant="ghost" onClick={requestClose} disabled={isSavingSettings}>
                    {t('common.close')}
                  </UiButton>
                  <UiButton variant="primary" onClick={handleSave} loading={isSavingSettings}>
                    {isSavingSettings ? t('common.saving') : t('common.save')}
                  </UiButton>
                </div>
              </>
            )}

            {activeCategory === 'about' && (
              <>
                <div className="px-6 py-5 border-b border-[var(--line)]">
                  <h2 className="text-[15px] font-semibold text-text-dark">
                    {t('settings.about')}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1">
                    {t('settings.aboutDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
                    <div className="flex items-start gap-4">
                      <img
                        src="/app-icon.png"
                        alt={t('settings.aboutAppName')}
                        className="h-14 w-14 rounded-lg border border-[var(--line)] object-cover"
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

                  <div className="rounded-xl border border-[var(--line)] bg-surface p-4 space-y-2 text-sm">
                    <p className="text-text-dark">
                      {t('settings.aboutVersionLabel')}: <span className="text-text-muted">{appVersion || t('settings.aboutVersionUnknown')}</span>
                    </p>
                    <p className="text-text-dark">
                      {t('settings.aboutAuthorLabel')}: <span className="text-text-muted">{t('settings.aboutAuthor')}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-text-dark">
                      <span>{t('settings.aboutRepositoryLabel')}:</span>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenRepository}
                        className="max-w-full text-left text-accent"
                        icon={<ExternalLink className="h-3.5 w-3.5 shrink-0" />}
                      >
                        <span className="break-all">{t('settings.aboutRepositoryUrl')}</span>
                      </UiButton>
                    </div>
                    <p className="text-text-dark">
                      {t('settings.aboutOriginalAuthorLabel')}: <span className="text-text-muted">{t('settings.aboutOriginalAuthor')}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-text-dark">
                      <span>{t('settings.aboutOriginalProjectLabel')}:</span>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenOriginalProject}
                        className="max-w-full text-left text-accent"
                        icon={<ExternalLink className="h-3.5 w-3.5 shrink-0" />}
                      >
                        <span className="break-all">{t('settings.aboutOriginalProjectUrl')}</span>
                      </UiButton>
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
                      <UiButton
                        onClick={() => {
                          void handleCheckUpdate();
                        }}
                        loading={checkUpdateStatus === 'checking'}
                      >
                        {checkUpdateStatus === 'checking'
                          ? t('settings.checkingUpdate')
                          : t('settings.checkUpdateNow')}
                      </UiButton>
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

                <div className="shrink-0 flex justify-end border-t border-[var(--line)] px-6 py-4">
                  {settingsSaved && <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {t('common.saved')}</span>}
                  <div className="flex gap-2">
                    <UiButton variant="ghost" onClick={requestClose} disabled={isSavingSettings}>
                      {t('common.close')}
                    </UiButton>
                    <UiButton variant="primary" onClick={handleSave} loading={isSavingSettings}>
                      {isSavingSettings ? t('common.saving') : t('common.save')}
                    </UiButton>
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
