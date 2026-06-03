import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Images, Upload, Sparkles, LayoutGrid, Type, Video } from 'lucide-react';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { MenuIconKey } from '@/features/canvas/domain/nodeRegistry';

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  showAssetOption?: boolean;
  onSelectAsset?: () => void;
  onSelect: (type: CanvasNodeType) => void;
  onClose: () => void;
}

const iconMap: Record<MenuIconKey, typeof Upload> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
};

export function NodeSelectionMenu({
  position,
  allowedTypes,
  showAssetOption = false,
  onSelectAsset,
  onSelect,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  const allowedTypeSet = useMemo(
    () => (allowedTypes ? new Set(allowedTypes) : null),
    [allowedTypes]
  );

  const menuItems = useMemo(() => {
    const candidates = !allowedTypeSet || !allowedTypes
      ? nodeCatalog.getMenuDefinitions()
      : Array.from(new Set(allowedTypes)).map((type) => nodeCatalog.getDefinition(type));

    const dedupedByLabel = new Map<string, (typeof candidates)[number]>();
    for (const definition of candidates) {
      const existing = dedupedByLabel.get(definition.menuLabelKey);
      if (!existing) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
        continue;
      }

      // Prefer user-visible definitions when multiple internal node types share the same label.
      if (!existing.visibleInMenu && definition.visibleInMenu) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
      }
    }

    return Array.from(dedupedByLabel.values());
  }, [allowedTypeSet, allowedTypes]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      handleClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [handleClose]);

  return (
    <div
      ref={menuRef}
      className={`
        absolute z-50 min-w-[220px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
        transition-opacity duration-150
        ${isVisible ? 'opacity-100' : 'opacity-0'}
      `}
      style={{ left: position.x, top: position.y }}
    >
      {menuItems.map((item, index) => {
        const Icon = iconMap[item.menuIcon] ?? Image;
        return (
          <button
            key={item.type}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
            onClick={() => {
              handleClose();
              setTimeout(() => onSelect(item.type), UI_POPOVER_TRANSITION_MS + 10);
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
              <Icon className="h-4 w-4 text-accent" />
            </div>
            <span className="text-sm text-text-dark">{t(item.menuLabelKey)}</span>
          </button>
        );
      })}
      {showAssetOption && onSelectAsset && (
        <button
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
          style={{ transitionDelay: isVisible ? `${menuItems.length * 30}ms` : '0ms' }}
          onClick={() => {
            setIsVisible(false);
            onSelectAsset();
          }}
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
            <Images className="h-4 w-4 text-accent" />
          </div>
          <span className="text-sm text-text-dark">{t('canvasToolbar.assets')}</span>
        </button>
      )}
    </div>
  );
}
