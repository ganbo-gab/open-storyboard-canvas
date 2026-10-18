import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProjectStore } from '@/stores/projectStore';

export function CanvasTopBar() {
  const { t } = useTranslation();
  const name = useProjectStore((state) => state.currentProject?.name ?? '');
  const closeProject = useProjectStore((state) => state.closeProject);

  return (
    <header className="canvas-topbar pointer-events-none absolute left-0 top-0 z-30 flex h-14 items-center px-4">
      <div className="pointer-events-auto flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="canvas-icon-button"
          title={t('rework.home')}
          aria-label={t('rework.home')}
          onClick={() => closeProject()}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="max-w-[240px] truncate px-1 text-[13px] text-white/88">{name}</span>
      </div>
    </header>
  );
}
