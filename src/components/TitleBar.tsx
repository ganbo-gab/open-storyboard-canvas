import { changeWindowSize } from './windowControls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronLeft, Languages, Maximize2, Minimize2, Minus, Moon, Settings, Sun, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/stores/themeStore';
import { useProjectStore } from '@/stores/projectStore';
import { Tooltip } from '@/components/ui';
import { setTopBarActionsSlot } from '@/components/topBarSlot';

interface TitleBarProps {
  onSettingsClick: () => void;
  /** Present while a project is open: back to home + editable project name. */
  onBackClick?: () => void;
  /** Float over the workspace, hidden until the pointer reaches the top edge (the canvas). */
  overlay?: boolean;
}

const HIDE_DELAY_MS = 450;

/**
 * The window's only top bar: window controls, back + project name, page actions (slot), language,
 * theme and settings. Quiet by default; on the canvas it takes no space and slides in on demand.
 */
export function TitleBar({ onSettingsClick, onBackClick, overlay: requestedOverlay = false }: TitleBarProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useThemeStore();
  const projectId = useProjectStore((state) => state.currentProjectId);
  const projectName = useProjectStore((state) => state.currentProject?.name ?? '');
  const renameProject = useProjectStore((state) => state.renameProject);
  const [draft, setDraft] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const hideTimerRef = useRef<number | undefined>(undefined);

  const isDesktopRuntime = isTauri();
  const appWindow = useMemo(() => isDesktopRuntime ? getCurrentWindow() : null, [isDesktopRuntime]);
  const overlay = requestedOverlay && !isDesktopRuntime;
  const [windowState, setWindowState] = useState({ maximized: false, fullscreen: false });
  const [windowError, setWindowError] = useState("");
  const sizing = useRef(false);
  const windowReadEpoch = useRef(0);
  const isMac =
    typeof navigator !== 'undefined'
    && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const inProject = Boolean(onBackClick && projectId);
  const switchLanguageLabel = i18n.language.startsWith('zh') ? t('titleBar.toEnglishHint') : t('titleBar.toChineseHint');
  const themeLabel = theme === 'dark' ? t('titleBar.toLightHint') : t('titleBar.toDarkHint');

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);
  // Leaving overlay mode (back to home) must not keep a stale "revealed" state.
  useEffect(() => { if (!overlay) setRevealed(false); }, [overlay]);

  const reveal = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    setRevealed(true);
  }, []);
  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setRevealed(false), HIDE_DELAY_MS);
  }, []);

  const handleMinimize = useCallback(async () => {
    if (!appWindow) return;
    try { await appWindow.minimize(); } catch { setWindowError(t('titleBar.minimizeFailed')); }
  }, [appWindow, t]);

  const updateWindowState = useCallback(async () => {
    if (!appWindow) return;
    const epoch = ++windowReadEpoch.current;
    try {
      const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
      if (epoch === windowReadEpoch.current) setWindowState({ maximized, fullscreen });
    } catch { /* An unavailable window event must not interrupt editing. */ }
  }, [appWindow]);

  const resizeWindow = useCallback(async (mode: 'maximize' | 'fullscreen') => {
    if (!appWindow || sizing.current) return;
    sizing.current = true; setWindowError('');
    try {
      await changeWindowSize(appWindow, mode);
      await updateWindowState();
    } catch { setWindowError(t('titleBar.resizeFailed')); }
    finally { sizing.current = false; }
  }, [appWindow, t, updateWindowState]);
  const handleMaximize = useCallback(() => resizeWindow('maximize'), [resizeWindow]);
  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    void updateWindowState();
    const unlisten = appWindow.onResized(() => { if (!disposed) void updateWindowState(); }).catch(() => null);
    const shortcut = (event: KeyboardEvent) => {
      const matches = isMac ? event.ctrlKey && event.metaKey && event.key.toLowerCase() === 'f' : event.key === 'F11';
      if (!matches || event.repeat || event.defaultPrevented) return;
      event.preventDefault(); void resizeWindow('fullscreen');
    };
    window.addEventListener('keydown', shortcut);
    return () => { disposed = true; windowReadEpoch.current++; void unlisten.then((off) => off?.()); window.removeEventListener('keydown', shortcut); };
  }, [appWindow, isMac, resizeWindow, updateWindowState]);
  const restorable = windowState.maximized || windowState.fullscreen;
  const maximizeLabel = restorable ? t('titleBar.restore') : t('titleBar.maximize');

  const handleClose = useCallback(async () => {
    if (!appWindow) return;
    try { await appWindow.close(); } catch { setWindowError(t('titleBar.closeFailed')); }
  }, [appWindow, t]);

  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if (!appWindow) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, a, [role="button"]') || target?.closest('[data-no-drag="true"]')) {
      return;
    }
    if (e.detail > 1) return;
    try { await appWindow.startDragging(); } catch { setWindowError(t('titleBar.dragFailed')); }
  }, [appWindow, t]);

  const handleLanguageClick = useCallback(() => {
    const newLang = i18n.language.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(newLang);
  }, [i18n]);

  const commitRename = () => {
    const next = draft?.trim();
    setDraft(null);
    if (projectId && next && next !== projectName) renameProject(projectId, next);
  };

  return (
    <div
      className="app-topbar select-none"
      data-overlay={overlay || undefined}
      data-revealed={(overlay && (revealed || draft !== null)) || undefined}
      onPointerEnter={overlay ? reveal : undefined}
      onPointerLeave={overlay ? scheduleHide : undefined}
    >
      {overlay ? (
        <div className="app-topbar__hotzone" aria-hidden="true">
          <span className="app-topbar__grip" />
        </div>
      ) : null}
      {windowError && <div role="alert" className="absolute right-3 top-full z-50 rounded-lg bg-elevated p-2 text-xs text-danger" onClick={() => setWindowError("")}>{windowError}</div>}
      <div className="app-topbar__bar">
        {isDesktopRuntime && isMac ? <div className="w-[82px] shrink-0" aria-hidden="true" data-no-drag="true" /> : null}

        <div
          className={`flex h-full min-w-0 flex-1 items-center gap-1 px-2 ${isDesktopRuntime ? 'cursor-move' : 'cursor-default'}`}
          onMouseDown={isDesktopRuntime ? handleDragStart : undefined}
          onDoubleClick={isDesktopRuntime ? (event) => { if (!(event.target instanceof Element) || event.target.closest('button,input,textarea,select,a,[role="button"],[data-no-drag]')) return; event.preventDefault(); void handleMaximize(); } : undefined}
        >
          {inProject ? (
            <>
              <Tooltip label={t('titleBar.backHint')} side="bottom">
                <button type="button" className="app-topbar__button" aria-label={t('titleBar.back')} onClick={onBackClick}>
                  <ChevronLeft />
                </button>
              </Tooltip>
              <span className="app-topbar__app">{t('app.title')}</span>
              <span className="app-topbar__sep" aria-hidden="true">/</span>
              {draft === null ? (
                <Tooltip label={t('titleBar.renameHint')} side="bottom">
                  <button type="button" className="app-topbar__title" onClick={() => setDraft(projectName)}>
                    {projectName}
                  </button>
                </Tooltip>
              ) : (
                <input
                  autoFocus
                  className="app-topbar__title"
                  aria-label={t('rework.projectName')}
                  value={draft}
                  maxLength={120}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setDraft(null);
                  }}
                />
              )}
            </>
          ) : (
            <span className="app-topbar__app">{t('app.title')}</span>
          )}
        </div>

        <div className="flex h-full items-center gap-0.5 pr-1.5">
          {/* Page actions (the canvas portals its agent launcher here). */}
          <div ref={setTopBarActionsSlot} className="app-topbar__actions" data-no-drag="true" />
          <Tooltip label={switchLanguageLabel} side="bottom">
            <button type="button" className="app-topbar__button" aria-label={switchLanguageLabel} onClick={handleLanguageClick}>
              <Languages />
            </button>
          </Tooltip>
          <Tooltip label={themeLabel} side="bottom">
            <button type="button" className="app-topbar__button" aria-label={themeLabel} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </button>
          </Tooltip>
          <Tooltip label={t('titleBar.settingsHint')} side="bottom-end">
            <button type="button" className="app-topbar__button" aria-label={t('settings.title')} onClick={onSettingsClick}>
              <Settings />
            </button>
          </Tooltip>

          {isDesktopRuntime && !isMac ? (
            <>
              <div className="mx-1 h-4 w-px bg-[var(--line)]" />
              <button type="button" className="app-topbar__button" title={t('titleBar.minimize')} aria-label={t('titleBar.minimize')} onClick={handleMinimize}>
                <Minus />
              </button>
              <button type="button" className="app-topbar__button" title={maximizeLabel} aria-label={maximizeLabel} onClick={handleMaximize}>
                {restorable ? <Minimize2 /> : <Maximize2 />}
              </button>
              <button type="button" className="app-topbar__button" data-tone="danger" title={t('titleBar.close')} aria-label={t('titleBar.close')} onClick={handleClose}>
                <X />
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
