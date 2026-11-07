import { useState } from 'react';
import { ClipboardPaste, Copy, CopyPlus, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui';
import { useNodeActions, type DownloadTarget, type NodeAction } from '../overlays/nodeActions';
import type { CanvasNode } from '../domain/canvasNodes';
import type { ContextMenuState } from '../state/canvasUiStore';
import { useCanvasActions } from '../engine/canvasActions';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { openMediaViewer } from '@/features/viewer/viewerStore';
import { showErrorDialog } from '../application/errorDialog';

/** Node title menu and right click share the toolbar's authoritative action list. */
export function SingleNodeMenu({ node, menu, onClose }: { node: CanvasNode; menu: ContextMenuState; onClose(): void }) {
  const { t } = useTranslation();
  const actions = useNodeActions(node);
  const canvas = useCanvasActions();
  const [downloads, setDownloads] = useState<DownloadTarget[] | null>(null);
  const run = async (action: NodeAction) => {
    const effect = action.effect;
    if (effect.kind === 'download' && effect.targets.length > 1) { setDownloads(effect.targets); return; }
    onClose();
    try {
      if (effect.kind === 'run') await effect.run();
      else if (effect.kind === 'download') await effect.targets[0]?.save();
      else if (effect.kind === 'preview') openMediaViewer([{ id: node.id, kind: effect.media, source: effect.source, title: String(node.data.displayName ?? '') }]);
      else usePanelStateStore.getState().openPanel(effect.panel, { nodeId: node.id, buttonKey: effect.panel, fallbackRect: new DOMRect(menu.clientX, menu.clientY, 1, 1) }, 'click');
    } catch (cause) { await showErrorDialog(cause instanceof Error ? cause.message : String(cause), t('common.error')); }
  };
  const invoke = (action: () => void) => { onClose(); action(); };
  return <MenuSurface anchor={menu.anchor ?? { x: menu.clientX, y: menu.clientY }} onClose={onClose} label={t('rework.canvas.menu.node')}>
    {downloads ? downloads.map((target, index) => <MenuItem key={index} icon={<FolderOpen />} label={target.label} onClick={() => { onClose(); void target.save().catch((cause: unknown) => showErrorDialog(String(cause), t('common.error'))); }} />) : <>
      <MenuItem icon={<Copy />} label={t('nodeToolbar.copyNode')} onClick={() => invoke(canvas.copySelection)} />
      <MenuItem icon={<CopyPlus />} label={t('rework.canvas.menu.duplicate')} onClick={() => invoke(canvas.duplicateSelection)} />
      <MenuItem icon={<ClipboardPaste />} label={t('nodeToolbar.paste')} onClick={() => invoke(() => void canvas.clipboard.pasteAt({ nodeId: node.id, flowPosition: menu.flowPosition }))} />
      <MenuSeparator />
      {actions.map((action) => <MenuItem key={action.id} icon={action.icon} label={action.label} onClick={() => void run(action)} />)}
    </>}
  </MenuSurface>;
}
