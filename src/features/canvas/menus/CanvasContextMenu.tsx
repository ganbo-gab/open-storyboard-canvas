import { useTranslation } from 'react-i18next';
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  ImagePlus,
  LayoutGrid,
  Maximize2,
  Plus,
  Redo2,
  SquareDashedMousePointer,
  Trash2,
  Type,
  Undo2,
  Ungroup,
  Upload,
  Wand2,
  Image as ImageIcon,
} from 'lucide-react';

import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui';
import { copyImageSourceToClipboard } from '@/commands/image';
import { CANVAS_GENERATION_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import { createCanvasNode } from '@/features/canvas/engine/nodeCreation';
import { shortcutLabel } from '@/features/canvas/engine/shortcuts';
import type { MaterialImportApi } from '@/features/canvas/io/useMaterialImport';
import { MEDIA_FILE_ACCEPT, pickFiles } from '@/features/canvas/io/pickFiles';
import { useCanvasUiStore, type ContextMenuState } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';

const GENERATION_TYPES = new Set<CanvasNodeType>(CANVAS_GENERATION_NODE_TYPES);

function imageSourceOf(data: Record<string, unknown>): string {
  const image = typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
  const preview = typeof data.previewImageUrl === 'string' ? data.previewImageUrl.trim() : '';
  return image || preview;
}

interface CanvasContextMenuProps {
  menu: ContextMenuState;
  materialImport: MaterialImportApi;
  scheduleCanvasPersist: (delayMs?: number) => void;
}

/**
 * One context menu with three scopes, chosen by what is under the pointer:
 * selected text → text actions; a node / the current selection → object actions; empty
 * canvas → canvas actions. Every item shows its shortcut so the menu teaches the keyboard.
 */
export function CanvasContextMenu({ menu, materialImport, scheduleCanvasPersist }: CanvasContextMenuProps) {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const closeMenus = useCanvasUiStore((state) => state.closeMenus);
  const openAddMenu = useCanvasUiStore((state) => state.openAddMenu);
  const nodes = useCanvasStore((state) => state.nodes);
  const history = useCanvasStore((state) => state.history);

  const node = menu.nodeId ? nodes.find((item) => item.id === menu.nodeId) : undefined;
  const selection = nodes.filter((item) => item.selected);
  const multi = Boolean(node?.selected) && selection.length > 1;
  const close = (action: () => void) => () => {
    closeMenus();
    action();
  };

  if (menu.selectedText) {
    const text = menu.selectedText;
    return (
      <MenuSurface anchor={{ x: menu.clientX, y: menu.clientY }} onClose={closeMenus} label={t('rework.canvas.menu.text')}>
        <MenuItem icon={<Copy />} label={t('nodeToolbar.copyText')} onClick={close(() => void actions.clipboard.copyText(text))} />
        <MenuItem
          icon={<ImagePlus />}
          label={t('nodeToolbar.generateImage')}
          onClick={close(() => {
            const nodeId = createCanvasNode({ type: CANVAS_NODE_TYPES.imageEdit, position: menu.flowPosition, configuration: { prompt: text } });
            if (nodeId) scheduleCanvasPersist(0);
            window.getSelection()?.removeAllRanges();
          })}
        />
        <MenuItem
          icon={<Type />}
          label={t('rework.canvas.menu.textToNote')}
          onClick={close(() => {
            const nodeId = createCanvasNode({ type: CANVAS_NODE_TYPES.textAnnotation, position: menu.flowPosition, configuration: { content: text } });
            if (nodeId) scheduleCanvasPersist(0);
          })}
        />
      </MenuSurface>
    );
  }

  if (node) {
    const imageSource = imageSourceOf(node.data as Record<string, unknown>);
    const isGroup = node.type === CANVAS_NODE_TYPES.group;
    const canGenerate = multi
      ? selection.some((item) => GENERATION_TYPES.has(item.type))
      : GENERATION_TYPES.has(node.type);
    return (
      <MenuSurface anchor={{ x: menu.clientX, y: menu.clientY }} onClose={closeMenus} label={t('rework.canvas.menu.node')}>
        {canGenerate ? (
          <>
            <MenuItem
              icon={<Wand2 />}
              label={multi ? t('rework.canvas.menu.generateCount', { count: selection.length }) : t('rework.canvas.menu.generate')}
              shortcut={shortcutLabel('generate.run')}
              onClick={close(actions.generateSelection)}
            />
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem
          icon={<Copy />}
          label={multi ? t('rework.canvas.menu.copyCount', { count: selection.length }) : t('nodeToolbar.copyNode')}
          shortcut={shortcutLabel('edit.copy')}
          onClick={close(actions.copySelection)}
        />
        <MenuItem icon={<CopyPlus />} label={t('rework.canvas.menu.duplicate')} shortcut={shortcutLabel('edit.duplicate')} onClick={close(actions.duplicateSelection)} />
        <MenuItem
          icon={<ClipboardPaste />}
          label={t('nodeToolbar.paste')}
          shortcut={shortcutLabel('edit.paste')}
          onClick={close(() => void actions.clipboard.pasteAt({ nodeId: node.id, flowPosition: menu.flowPosition }))}
        />
        {imageSource && !multi ? (
          <MenuItem
            icon={<ImageIcon />}
            label={t('rework.canvas.menu.copyImage')}
            onClick={close(() => void copyImageSourceToClipboard(imageSource).catch((error) => console.warn('copy image failed', error)))}
          />
        ) : null}
        <MenuSeparator />
        {multi ? (
          <>
            <MenuItem icon={<Group />} label={t('rework.canvas.menu.group')} shortcut={shortcutLabel('organize.group')} onClick={close(actions.groupSelection)} />
            <MenuItem icon={<LayoutGrid />} label={t('rework.canvas.menu.arrangeGrid')} onClick={close(() => actions.layoutSelection('grid'))} />
          </>
        ) : null}
        {isGroup ? (
          <MenuItem icon={<Ungroup />} label={t('rework.canvas.menu.ungroup')} shortcut={shortcutLabel('organize.ungroup')} onClick={close(actions.ungroupSelection)} />
        ) : null}
        <MenuItem icon={<Maximize2 />} label={t('rework.canvas.menu.focus')} onClick={close(() => actions.focusNodes(multi ? selection.map((item) => item.id) : [node.id]))} />
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 />}
          tone="danger"
          label={multi ? t('rework.canvas.menu.deleteCount', { count: selection.length }) : t('common.delete')}
          shortcut={shortcutLabel('edit.delete')}
          onClick={close(actions.deleteSelection)}
        />
      </MenuSurface>
    );
  }

  return (
    <MenuSurface anchor={{ x: menu.clientX, y: menu.clientY }} onClose={closeMenus} label={t('rework.canvas.menu.canvas')}>
      <MenuItem
        icon={<Plus />}
        label={t('rework.canvas.add')}
        shortcut={shortcutLabel('node.add')}
        onClick={() => openAddMenu({ clientX: menu.clientX, clientY: menu.clientY, flowPosition: menu.flowPosition })}
      />
      <MenuItem
        icon={<Upload />}
        label={t('rework.canvas.addMenu.upload')}
        onClick={close(() => {
          void pickFiles({ accept: MEDIA_FILE_ACCEPT }).then(async (files) => {
            let offset = 0;
            for (const file of files) {
              await materialImport.createFromFile(file, { x: menu.flowPosition.x + offset, y: menu.flowPosition.y + offset });
              offset += 36;
            }
          });
        })}
      />
      <MenuItem
        icon={<ClipboardPaste />}
        label={t('nodeToolbar.paste')}
        shortcut={shortcutLabel('edit.paste')}
        onClick={close(() => void actions.clipboard.pasteAt({ nodeId: null, flowPosition: menu.flowPosition }))}
      />
      <MenuSeparator />
      <MenuItem icon={<Undo2 />} label={t('rework.canvas.undo')} shortcut={shortcutLabel('edit.undo')} disabled={history.past.length === 0} onClick={close(actions.undo)} />
      <MenuItem icon={<Redo2 />} label={t('rework.canvas.redo')} shortcut={shortcutLabel('edit.redo')} disabled={history.future.length === 0} onClick={close(actions.redo)} />
      <MenuSeparator />
      <MenuItem icon={<SquareDashedMousePointer />} label={t('rework.canvas.menu.selectAll')} shortcut={shortcutLabel('edit.selectAll')} disabled={nodes.length === 0} onClick={close(actions.selectAll)} />
      <MenuItem icon={<LayoutGrid />} label={t('rework.canvas.organize')} disabled={nodes.length < 2} onClick={close(actions.organizeCanvas)} />
      <MenuItem icon={<Maximize2 />} label={t('rework.canvas.fit')} shortcut={shortcutLabel('view.fit')} disabled={nodes.length === 0} onClick={close(actions.fitView)} />
    </MenuSurface>
  );
}
