import { useTranslation } from 'react-i18next';
import { Clapperboard, ImagePlus, Type, Upload, Video } from 'lucide-react';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import { formatChord, shortcutLabel } from '@/features/canvas/engine/shortcuts';
import type { MaterialImportApi } from '@/features/canvas/io/useMaterialImport';
import { MEDIA_FILE_ACCEPT, pickFiles } from '@/features/canvas/io/pickFiles';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * First-run surface for an empty canvas: start with a node type or a file, and learn the
 * three gestures that matter. Disappears with the first node.
 */
export function CanvasEmptyState({ materialImport }: { materialImport: MaterialImportApi }) {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const isEmpty = useCanvasStore((state) => state.nodes.length === 0);
  if (!isEmpty) return null;

  const upload = async () => {
    const files = await pickFiles({ accept: MEDIA_FILE_ACCEPT });
    const center = actions.viewportCenter();
    let offset = 0;
    for (const file of files) {
      await materialImport.createFromFile(file, { x: center.x - 200 + offset, y: center.y - 150 + offset });
      offset += 36;
    }
  };

  const starters = [
    { key: 'text', icon: Type, run: () => actions.createNode(CANVAS_NODE_TYPES.textAnnotation) },
    { key: 'image', icon: ImagePlus, run: () => actions.createNode(CANVAS_NODE_TYPES.imageEdit) },
    { key: 'video', icon: Video, run: () => actions.createNode(CANVAS_NODE_TYPES.aiVideo) },
    {
      key: 'stage',
      icon: Clapperboard,
      run: () => actions.createNode(CANVAS_NODE_TYPES.blueprint, undefined, { openDirectorStudio: true, directorStudioMode: 'flat' }),
    },
  ] as const;

  return (
    <div className="canvas-empty">
      <div className="canvas-empty__card" data-canvas-overlay="">
        <div>
          <div className="canvas-empty__title">{t('rework.canvas.empty')}</div>
          <div className="canvas-empty__hint">{t('rework.canvas.emptyHint')}</div>
        </div>
        <div className="canvas-empty__actions">
          {starters.map(({ key, icon: Icon, run }) => (
            <button key={key} type="button" className="canvas-empty__action" onClick={() => void run()}>
              <Icon />
              {t(`rework.canvas.emptyStart.${key}`)}
            </button>
          ))}
          <button type="button" className="canvas-empty__action" onClick={() => void upload()}>
            <Upload />
            {t('rework.canvas.addMenu.upload')}
          </button>
        </div>
        <div className="canvas-empty__gestures">
          <span><kbd className="ui-kbd">{formatChord('tab')}</kbd>{t('rework.canvas.emptyGestures.add')}</span>
          <span><kbd className="ui-kbd">{formatChord('space')}</kbd>{t('rework.canvas.emptyGestures.pan')}</span>
          <span><kbd className="ui-kbd">{shortcutLabel('view.palette')}</kbd>{t('rework.canvas.emptyGestures.search')}</span>
          <span><kbd className="ui-kbd">?</kbd>{t('rework.canvas.emptyGestures.shortcuts')}</span>
        </div>
      </div>
    </div>
  );
}
