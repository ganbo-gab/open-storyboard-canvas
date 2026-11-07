import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Search, Upload } from 'lucide-react';

import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import type { MaterialImportApi } from '@/features/canvas/io/useMaterialImport';
import { MEDIA_FILE_ACCEPT, pickFiles } from '@/features/canvas/io/pickFiles';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { createCanvasNode } from '@/features/canvas/engine/nodeCreation';
import { useCanvasUiStore, type AddMenuState } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { ADD_NODE_CATALOG, type AddNodeEntry } from './addNodeCatalog';

interface AddNodeMenuProps {
  menu: AddMenuState;
  materialImport: MaterialImportApi;
  scheduleCanvasPersist: (delayMs?: number) => void;
  /** Pick an existing canvas image as the input of `targetNodeId`. */
  onPickCanvasAsset: (targetNodeId: string, anchor: { x: number; y: number }) => void;
}

export function AddNodeMenu({ menu, materialImport, scheduleCanvasPersist, onPickCanvasAsset }: AddNodeMenuProps) {
  const { t } = useTranslation();
  const closeMenus = useCanvasUiStore((state) => state.closeMenus);
  const [query, setQuery] = useState('');
  const connection = menu.connection;

  const entries = useMemo(() => {
    const allowed = menu.allowedTypes ? new Set(menu.allowedTypes) : null;
    const needle = query.trim().toLowerCase();
    return ADD_NODE_CATALOG.filter((entry) => {
      if (allowed && !allowed.has(entry.type)) return false;
      if (!needle) return true;
      return `${t(entry.labelKey)} ${t(entry.hintKey)}`.toLowerCase().includes(needle);
    });
  }, [menu.allowedTypes, query, t]);

  const targetNode = connection?.handleType === 'target'
    ? useCanvasStore.getState().nodes.find((node) => node.id === connection.nodeId)
    : undefined;
  const canPickCanvasAsset = targetNode?.type === CANVAS_NODE_TYPES.imageEdit;
  // Uploads are material sources; they fit any menu that is not "wire into a source handle".
  const canUpload = !connection || connection.handleType === 'target';

  const pick = (entry: AddNodeEntry) => {
    const configuration = entry.type === CANVAS_NODE_TYPES.tagGroup
      ? { ...entry.configuration, displayName: t('node.menu.tagGroup') }
      : entry.configuration;
    const nodeId = createCanvasNode({
      type: entry.type,
      position: menu.flowPosition,
      configuration,
      connection: connection ? { nodeId: connection.nodeId, handleType: connection.handleType } : undefined,
    });
    if (nodeId) scheduleCanvasPersist(0);
    closeMenus();
  };

  const upload = async () => {
    // Capture what we need: the menu unmounts while the system dialog is open.
    const { flowPosition } = menu;
    closeMenus();
    const files = await pickFiles({ accept: MEDIA_FILE_ACCEPT });
    let offset = 0;
    for (const file of files) {
      const created = await materialImport.createFromFile(file, {
        x: flowPosition.x + offset,
        y: flowPosition.y + offset,
      });
      offset += 36;
      if (created && connection?.handleType === 'target') {
        await canvasCommandRegistry.execute({
          type: 'edge.connect',
          version: CANVAS_COMMAND_VERSION,
          input: { sourceNodeId: created.nodeId, targetNodeId: connection.nodeId },
        }, 'ui');
        scheduleCanvasPersist(0);
      }
    }
  };

  const generate = entries.filter((entry) => entry.group === 'generate');
  const content = entries.filter((entry) => entry.group === 'content');

  return (
    <>
      {connection ? <ConnectionPreview from={connection.fromClient} to={{ x: menu.clientX, y: menu.clientY }} /> : null}
      <MenuSurface
        anchor={menu.anchor ?? { x: menu.clientX, y: menu.clientY }}
        onClose={closeMenus}
        width={272}
        label={connection ? t('rework.canvas.addMenu.fromConnection') : t('rework.canvas.add')}
      >
        <label className="ui-menu__search">
          <Search className="h-4 w-4" />
          <input
            autoFocus
            value={query}
            placeholder={t('rework.canvas.addMenu.search')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && entries[0]) {
                event.preventDefault();
                pick(entries[0]);
              }
            }}
          />
        </label>
        {connection ? <MenuLabel>{t('rework.canvas.addMenu.fromConnection')}</MenuLabel> : null}
        {generate.length > 0 ? (
          <>
            {connection ? null : <MenuLabel>{t('rework.canvas.addMenu.generate')}</MenuLabel>}
            {generate.map((entry) => <CatalogItem key={entry.type} entry={entry} onPick={pick} />)}
          </>
        ) : null}
        {content.length > 0 ? (
          <>
            <MenuLabel>{t('rework.canvas.addMenu.content')}</MenuLabel>
            {content.map((entry) => <CatalogItem key={entry.type} entry={entry} onPick={pick} />)}
          </>
        ) : null}
        {entries.length === 0 && query ? <div className="ui-menu__empty">{t('rework.noMatches')}</div> : null}
        {(canUpload || canPickCanvasAsset) && !query ? (
          <>
            <MenuSeparator />
            <MenuLabel>{t('rework.canvas.addMenu.resources')}</MenuLabel>
            {canUpload ? (
              <MenuItem
                icon={<Upload />}
                label={t('rework.canvas.addMenu.upload')}
                hint={t('rework.canvas.addMenu.uploadHint')}
                onClick={() => void upload()}
              />
            ) : null}
            {canPickCanvasAsset && targetNode ? (
              <MenuItem
                icon={<FolderOpen />}
                label={t('rework.canvas.addMenu.canvasAsset')}
                hint={t('rework.canvas.addMenu.canvasAssetHint')}
                onClick={() => {
                  closeMenus();
                  onPickCanvasAsset(targetNode.id, { x: menu.clientX, y: menu.clientY });
                }}
              />
            ) : null}
          </>
        ) : null}
      </MenuSurface>
    </>
  );
}

function CatalogItem({ entry, onPick }: { entry: AddNodeEntry; onPick: (entry: AddNodeEntry) => void }) {
  const { t } = useTranslation();
  const Icon = entry.icon;
  return <MenuItem icon={<Icon />} label={t(entry.labelKey)} hint={t(entry.hintKey)} onClick={() => onPick(entry)} />;
}

function ConnectionPreview({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const bend = Math.max(40, Math.min(140, Math.abs(to.x - from.x) * 0.45));
  const direction = to.x >= from.x ? 1 : -1;
  const path = `M ${from.x} ${from.y} C ${from.x + bend * direction} ${from.y}, ${to.x - bend * direction} ${to.y}, ${to.x} ${to.y}`;
  return (
    <svg className="canvas-connection-preview" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
