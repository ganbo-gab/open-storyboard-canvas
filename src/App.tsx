import { lazy, Suspense, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { GenerationDetailsHost } from './features/library/ui/GenerationDetailsDialog';
import { StudioCommandMenu } from './features/studio/StudioCommandMenu';
import { MediaViewerHost } from './features/viewer/MediaViewerHost';
import { TitleBar } from './components/TitleBar';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { UpdateAvailableDialog, type UpdateIgnoreMode } from './components/UpdateAvailableDialog';
import { GlobalErrorDialog } from './components/GlobalErrorDialog';
import { UiButton } from './components/ui';
import { launchLocation, settleLaunchLocation } from './features/studio/appLocation';
import { StudioShell } from './features/studio/StudioShell';
import { useThemeStore } from './stores/themeStore';
import { useProjectStore } from './stores/projectStore';
import { useSettingsStore } from './stores/settingsStore';
import {
  checkForUpdate,
  isUpdateVersionSuppressed,
  suppressUpdateVersion,
} from './features/update/application/checkForUpdate';
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from './features/app/errorDialogEvents';
import {
  subscribeOpenSettingsDialog,
  type SettingsCategory,
} from './features/settings/settingsEvents';
import { subscribeWebProjectStorageStatus } from './commands/projectState';

const CanvasWorkspace = lazy(() =>
  import('./features/canvas/CanvasWorkspace').then((module) => ({
    default: module.CanvasWorkspace,
  })),
);
const SettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((module) => ({
    default: module.SettingsDialog,
  })),
);

function toRgbCssValue(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '59 130 246';
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function App() {
  const { t } = useTranslation();
  const { theme } = useThemeStore();
  const uiRadiusPreset = useSettingsStore((state) => state.uiRadiusPreset);
  const themeTonePreset = useSettingsStore((state) => state.themeTonePreset);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const accentSource = useSettingsStore((state) => state.accentSource);
  const autoCheckAppUpdateOnLaunch = useSettingsStore((state) => state.autoCheckAppUpdateOnLaunch);
  const enableUpdateDialog = useSettingsStore((state) => state.enableUpdateDialog);
  const setEnableUpdateDialog = useSettingsStore((state) => state.setEnableUpdateDialog);
  const [showSettings, setShowSettings] = useState(false);
  const [hasOpenedSettings, setHasOpenedSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);
  const [showWebStorageFallback, setShowWebStorageFallback] = useState(false);

  const isHydrated = useProjectStore((state) => state.isHydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const closeProject = useProjectStore((state) => state.closeProject);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.uiRadius = uiRadiusPreset;
  }, [uiRadiusPreset]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themeTone = themeTonePreset;
  }, [themeTonePreset]);

  useEffect(() => {
    const root = document.documentElement;
    const isMac =
      typeof navigator !== 'undefined'
      && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
    root.dataset.platform = isMac ? 'macos' : 'default';
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (accentSource === 'theme') {
      // The active color theme supplies --accent-rgb from CSS.
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-rgb');
      return;
    }
    const normalized = accentColor.startsWith('#') ? accentColor : `#${accentColor}`;
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-rgb', toRgbCssValue(normalized));
  }, [accentColor, accentSource]);

  useEffect(() => {
    return subscribeWebProjectStorageStatus((status) => {
      if (status.mode === 'memory') {
        setShowWebStorageFallback(true);
      }
    });
  }, []);

  useEffect(() => {
    // Reload / restart: return to the canvas that was open. A failed hydrate still releases location writes.
    void hydrate().then(() => {
      const { projects, currentProjectId: openId, openProject } = useProjectStore.getState();
      const launch = launchLocation;
      if (launch.view !== 'canvas' || openId) return settleLaunchLocation(null);
      const exists = projects.some((project) => project.id === launch.projectId);
      settleLaunchLocation(exists ? null : { view: 'home' });
      if (exists) openProject(launch.projectId);
    }, () => settleLaunchLocation({ view: 'home' }));
  }, [hydrate]);

  useEffect(() => {
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => {
      setGlobalError(detail);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOpenSettingsDialog(({ category }) => {
      setSettingsInitialCategory(category ?? 'general');
      setHasOpenedSettings(true);
      setShowSettings(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const notifyFrontendReady = async (attempt = 1) => {
      if (cancelled) {
        return;
      }

      try {
        await invoke('frontend_ready');
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (attempt === 1 || attempt % 10 === 0) {
          console.warn('failed to notify frontend readiness', error);
        }

        const retryDelayMs = Math.min(500, 80 * attempt);
        retryTimer = window.setTimeout(() => {
          void notifyFrontendReady(attempt + 1);
        }, retryDelayMs);
      }
    };

    requestAnimationFrame(() => {
      void notifyFrontendReady();
    });

    return () => {
      cancelled = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    let cancelled = false;
    const runUpdateCheck = async () => {
      if (!autoCheckAppUpdateOnLaunch) {
        return;
      }
      const result = await checkForUpdate();
      if (!cancelled && result.hasUpdate && result.latestVersion && enableUpdateDialog) {
        if (isUpdateVersionSuppressed(result.latestVersion)) {
          return;
        }
        setLatestVersion(result.latestVersion ?? '');
        setCurrentVersion(result.currentVersion ?? '');
        setShowUpdateDialog(true);
      }
    };

    void runUpdateCheck();
    return () => {
      cancelled = true;
    };
  }, [isHydrated, autoCheckAppUpdateOnLaunch, enableUpdateDialog]);

  const handleManualCheckUpdate = async (): Promise<'has-update' | 'up-to-date' | 'failed'> => {
    const result = await checkForUpdate();
    if (!result.hasUpdate) {
      return result.error ? 'failed' : 'up-to-date';
    }

    setLatestVersion(result.latestVersion ?? '');
    setCurrentVersion(result.currentVersion ?? '');

    if (enableUpdateDialog) {
      setShowUpdateDialog(true);
    }

    return 'has-update';
  };

  const handleApplyIgnore = (mode: UpdateIgnoreMode) => {
    if (mode === 'forever-all') {
      setEnableUpdateDialog(false);
      return;
    }

    if (!latestVersion) {
      return;
    }

    suppressUpdateVersion(latestVersion, mode === 'today-version' ? 'today' : 'forever');
  };

  if (!isHydrated) {
    return (
      <AppErrorBoundary>
        <div className="h-full w-full bg-bg" />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
        <div className="relative w-full h-full flex flex-col bg-bg">
          <TitleBar
            onSettingsClick={() => {
              setSettingsInitialCategory('general');
              setHasOpenedSettings(true);
              setShowSettings(true);
            }}
            onBackClick={currentProjectId ? closeProject : undefined}
            overlay={Boolean(currentProjectId)}
          />

          {showWebStorageFallback ? (
            <div
              role="status"
              className="flex shrink-0 items-center justify-between gap-4 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-text-dark"
            >
              <span>{t('project.webStorageFallback')}</span>
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setShowWebStorageFallback(false)}
              >
                {t('common.close')}
              </UiButton>
            </div>
          ) : null}

          <main className="relative min-h-0 flex-1 overflow-hidden">
            <StudioShell onSettings={() => { setSettingsInitialCategory('providersAdd'); setHasOpenedSettings(true); setShowSettings(true); }}>
            {currentProjectId ? (
              <div
                key={`canvas-${currentProjectId}`}
                className="relative h-full min-h-0 min-w-0 overflow-hidden"
              >
                <Suspense
                  fallback={(
                    <div
                      role="status"
                      className="flex h-full items-center justify-center gap-2 bg-bg text-sm text-text-muted"
                    >
                      <span className="h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                      {t('common.loading')}
                    </div>
                  )}
                >
                  <CanvasWorkspace projectId={currentProjectId} />
                </Suspense>
              </div>
            ) : null}
            </StudioShell>
          </main>

          {hasOpenedSettings ? (
            <Suspense
              fallback={showSettings ? (
                <div
                  role="status"
                  className="fixed inset-0 z-100000 flex items-center justify-center bg-[var(--scrim)] text-sm text-text-dark backdrop-blur-xs"
                >
                  {t('common.loading')}
                </div>
              ) : null}
            >
              <SettingsDialog
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                initialCategory={settingsInitialCategory}
                onCheckUpdate={handleManualCheckUpdate}
              />
            </Suspense>
          ) : null}
          <UpdateAvailableDialog
            isOpen={showUpdateDialog}
            onClose={() => setShowUpdateDialog(false)}
            latestVersion={latestVersion}
            currentVersion={currentVersion}
            onApplyIgnore={handleApplyIgnore}
          />
          <MediaViewerHost />
          <GenerationDetailsHost />
          <StudioCommandMenu />
          <GlobalErrorDialog
            isOpen={Boolean(globalError)}
            title={globalError?.title ?? ''}
            message={globalError?.message ?? ''}
            details={globalError?.details}
            copyText={globalError?.copyText}
            onClose={() => setGlobalError(null)}
          />
        </div>
      </AppErrorBoundary>
  );
}

export default App;
