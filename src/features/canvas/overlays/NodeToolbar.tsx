import { useSettingsStore } from '@/stores/settingsStore';
import { arrangeToolbarItems } from '@/features/settings/workspacePreferences';
import { ToolbarPreferencesDialog } from '@/features/settings/ToolbarPreferencesDialog';
import { memo, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useStore } from '@xyflow/react';
import { Check, ChevronDown, FolderOpen, MoreHorizontal, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MenuItem, MenuSurface, Tooltip, UiModal, anchorBelow, type MenuAnchor } from '@/components/ui';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { resolveCanvasImageOriginalDisplayUrl } from '@/features/canvas/application/canvasImageThumbnails';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { SafeNodeToolbar } from '@/features/canvas/ui/SafeNodeToolbar';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { fitActionCount, useNodeActions, type DownloadTarget, type NodeAction } from './nodeActions';

const TOOLBAR_OFFSET = 25;
/** Toolbar width never exceeds the canvas minus the left rail and both insets. */
const SIDE_MARGIN = 68 + 24;
const GAP = 2;
const PADDING = 8;
const MORE_WIDTH = 32;

/**
 * Selection toolbar for one node: actions from `useNodeActions`, as many as fit the canvas width,
 * the rest in "More". Placement (flip/clamp, composer avoidance) is SafeNodeToolbar's.
 */
export const NodeToolbar = memo(function NodeToolbar({ node, collapsible }: { node: CanvasNode; collapsible: boolean }) {
  const { t } = useTranslation();
  const actions = useNodeActions(node);
  const config = useSettingsStore((state) => state.workspacePreferences.nodeToolbar);
  const [customizing, setCustomizing] = useState(false);
  const canvasWidth = useStore((state) => state.width);
  const openPanel = usePanelStateStore((state) => state.openPanel);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [expanded, setExpanded] = useState(!collapsible);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: 'more' | DownloadTarget[] } | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  const signature = actions.map((action) => `${action.id}:${action.label}`).join('|');

  useLayoutEffect(() => {
    const row = measureRef.current;
    if (!row) return;
    const next = Array.from(row.children, (child) => Math.ceil((child as HTMLElement).getBoundingClientRect().width));
    setWidths((old) => (old.length === next.length && old.every((width, index) => width === next[index]) ? old : next));
  }, [signature, expanded]);

  useLayoutEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 1800);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const arranged = arrangeToolbarItems(actions, config);
  const available = Math.min(820, Math.max(0, canvasWidth - SIDE_MARGIN - PADDING));
  const desiredWidths = arranged.visible.map((action) => widths[actions.indexOf(action)] ?? 110);
  const fitted = fitActionCount(desiredWidths, available - MORE_WIDTH, MORE_WIDTH, GAP);
  const visible = arranged.visible.slice(0, fitted);
  const overflow = [...arranged.visible.slice(fitted), ...arranged.more];

  const trigger = async (action: NodeAction, element: HTMLElement) => {
    const { effect } = action;
    if (effect.kind === 'panel') {
      element.dataset.panelAnchor = `${node.id}:${effect.panel}`;
      openPanel(effect.panel, { nodeId: node.id, buttonKey: effect.panel, fallbackRect: element.getBoundingClientRect() }, 'click');
      return;
    }
    if (effect.kind === 'preview') {
      // Durable sources (browser asset-media handles, desktop paths) become a session display URL here.
      try {
        const display = await resolveCanvasImageOriginalDisplayUrl(effect.source);
        if (effect.media === 'image') useCanvasStore.getState().openImageViewer(display);
        else setVideo(display);
      } catch (error) {
        await showErrorDialog(error instanceof Error ? error.message : String(error), t('common.error'));
      }
      return;
    }
    if (effect.kind === 'download' && effect.targets.length > 1) {
      setMenu(current => current?.anchor.trigger === element ? null : { anchor: anchorBelow(element), items: effect.targets });
      return;
    }
    try {
      if (effect.kind === 'download') {
        if (await effect.targets[0].save()) setFeedback({ text: t('nodeToolbar.downloadSuccess'), tone: 'ok' });
        return;
      }
      const message = await effect.run();
      if (message) setFeedback({ text: message, tone: 'ok' });
    } catch (error) {
      const text = effect.kind === 'download' ? t('nodeToolbar.downloadFailed') : t('nodeToolbar.copyFailed');
      if (action.id === 'copy' || effect.kind === 'download') setFeedback({ text, tone: 'error' });
      else await showErrorDialog(error instanceof Error ? error.message : String(error), t('common.error'));
    }
  };

  const onAction = (action: NodeAction) => (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void trigger(action, event.currentTarget);
  };

  const renderButton = (action: NodeAction, measuring = false) => (
    <button
      key={action.id}
      type="button"
      tabIndex={measuring ? -1 : undefined}
      className="canvas-action"
      data-tone={action.tone}
      aria-haspopup={action.disclosure ? 'dialog' : undefined}
      onClick={measuring ? undefined : onAction(action)}
    >
      {action.icon}
      {action.label}
      {action.disclosure ? <ChevronDown className="canvas-action__chevron" /> : null}
    </button>
  );

  const pickFromMenu = (target: DownloadTarget | NodeAction) => {
    const anchor = moreRef.current;
    setMenu(null);
    if ('effect' in target) {
      if (anchor) void trigger(target, anchor);
      return;
    }
    void target.save()
      .then((saved) => { if (saved) setFeedback({ text: t('nodeToolbar.downloadSuccess'), tone: 'ok' }); })
      .catch(() => setFeedback({ text: t('nodeToolbar.downloadFailed'), tone: 'error' }));
  };

  return (
    <>
      <SafeNodeToolbar nodeId={node.id} offset={TOOLBAR_OFFSET} className="pointer-events-auto">
        <div className="canvas-chrome node-toolbar" role="toolbar" aria-label={t('rework.canvas.menu.node')}>
          {!expanded ? (
            <button type="button" className="canvas-action" onClick={(event) => { event.stopPropagation(); setExpanded(true); }}>
              <SlidersHorizontal />{t('nodeToolbar.toolbarToggle')}
            </button>
          ) : (
            <>
              {visible.map((action) => renderButton(action))}
              {(
                <Tooltip label={t('rework.canvas.moreActions')} side="top">
                  <button
                    ref={moreRef}
                    type="button"
                    className="canvas-action canvas-action--icon"
                    aria-label={t('rework.canvas.moreActions')}
                    aria-expanded={menu?.items === 'more'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenu(menu?.items === 'more' ? null : { anchor: anchorBelow(event.currentTarget), items: 'more' });
                    }}
                  >
                    <MoreHorizontal />
                  </button>
                </Tooltip>
              )}
              {collapsible ? (
                <button type="button" className="canvas-action canvas-action--icon" aria-label={t('nodeToolbar.collapseToolbar')} onClick={(event) => { event.stopPropagation(); setExpanded(false); }}>
                  <ChevronDown className="rotate-180" />
                </button>
              ) : null}
            </>
          )}
          {/* Off-screen copy of every action, measured to decide how many fit. */}
          {expanded ? (
            <div ref={measureRef} className="node-toolbar__measure" aria-hidden="true">
              {actions.map((action) => renderButton(action, true))}
            </div>
          ) : null}
          {feedback ? (
            <span className="node-toolbar__feedback" role="status" data-tone={feedback.tone}>
              {feedback.tone === 'ok' ? <Check /> : null}{feedback.text}
            </span>
          ) : null}
        </div>
      </SafeNodeToolbar>
      {menu ? (
        <MenuSurface anchor={menu.anchor} onClose={() => setMenu(null)} width={menu.items === 'more' ? 220 : 280}>
          {menu.items === 'more'
            ? overflow.map((action) => (
              <MenuItem key={action.id} icon={action.icon} label={action.label} tone={action.tone} onClick={() => pickFromMenu(action)} />
            ))
            : menu.items.map((target, index) => (
              <MenuItem key={target.label} icon={index === 0 && target.label === t('nodeToolbar.saveAs') ? undefined : <FolderOpen />} label={target.label} onClick={() => pickFromMenu(target)} />
            ))}
          {menu.items === 'more' && <MenuItem icon={<SlidersHorizontal />} label="自定义工具栏…" onClick={() => { setMenu(null); setCustomizing(true); }} />}
        </MenuSurface>
      ) : null}
      {customizing && <ToolbarPreferencesDialog target="nodeToolbar" items={actions.map(({ id, label }) => ({ id, label }))} onClose={() => setCustomizing(false)} />}
      <UiModal isOpen={video !== null} title={t('nodeToolbar.zoomPreview')} onClose={() => setVideo(null)} widthClassName="w-[min(94vw,1080px)]">
        {video ? <video src={video} className="max-h-[78vh] w-full rounded-lg bg-black object-contain" controls autoPlay playsInline /> : null}
      </UiModal>
    </>
  );
});
