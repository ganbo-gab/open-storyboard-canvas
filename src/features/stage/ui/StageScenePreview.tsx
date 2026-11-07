import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import type { BlueprintSceneHandle } from '@/features/canvas/ui/BlueprintScene';

const Scene = lazy(() => import('@/features/canvas/ui/BlueprintScene').then((module) => ({ default: module.BlueprintScene })));

/** A real, isolated Three.js preview. It never writes to the active stage or its history. */
export function StageScenePreview({ items }: { items: BlueprintItem[] }) {
  const { t } = useTranslation();
  const ref = useRef<BlueprintSceneHandle>(null);
  const [error, setError] = useState('');
  const [sandbox, setSandbox] = useState(items);
  const [selected, setSelected] = useState<string | null>(null);
  const fit = useCallback(() => ref.current?.fitCamera('front'), []);
  const attachScene = useCallback((instance: BlueprintSceneHandle | null) => { ref.current = instance; instance?.fitCamera('front'); }, []);
  useEffect(() => { setSandbox(items); setError(''); setSelected(null); }, [items]);
  return (
    <section className="space-y-1.5" aria-label={t('rework.stage.sceneBuilder.preview')}>
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{t('rework.stage.sceneBuilder.preview')}</span>
        <UiButton size="sm" variant="ghost" onClick={fit}>{t('directorStudio.scene.fitAll')}</UiButton>
      </div>
      <div className="pointer-events-none overflow-hidden rounded-lg" aria-hidden="true">
        <Suspense fallback={<p className="p-5 text-xs text-text-muted">{t('common.loading')}</p>}>
          <Scene ref={attachScene} items={sandbox} onItemsChange={setSandbox} selectedItemId={selected} onSelectedItemChange={setSelected} width={312} height={190} fullBleed keyboardShortcutsEnabled={false} onAssetReady={fit} onAssetLoadError={setError} />
        </Suspense>
      </div>
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    </section>
  );
}
