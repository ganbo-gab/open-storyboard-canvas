import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveCanvasImageOriginalDisplayUrl } from '@/features/canvas/application/canvasImageThumbnails';
import { useCanvasStore } from '@/stores/canvasStore';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
  fallbackSrcs?: Array<string | null | undefined>;
  disableViewer?: boolean;
  /** A display source is still being prepared: show the neutral media box, not the missing state. */
  pending?: boolean;
}

function normalizeViewerList(
  imageList: Array<string | null | undefined> | undefined,
  currentImageUrl: string
): string[] {
  const deduped: string[] = [];
  for (const rawItem of imageList ?? []) {
    const item = typeof rawItem === 'string' ? rawItem.trim() : '';
    if (!item || deduped.includes(item)) {
      continue;
    }
    deduped.push(item);
  }

  if (!deduped.includes(currentImageUrl)) {
    deduped.unshift(currentImageUrl);
  }

  return deduped.length > 0 ? deduped : [currentImageUrl];
}

export const CanvasNodeImage = memo(({
  viewerSourceUrl,
  viewerImageList,
  fallbackSrcs,
  disableViewer = false,
  pending = false,
  onDoubleClick,
  onError,
  src,
  alt,
  className,
  ...props
}: CanvasNodeImageProps) => {
  const { t } = useTranslation();
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const candidateSources = useMemo(() => {
    const deduped: string[] = [];
    for (const rawItem of [src, ...(fallbackSrcs ?? [])]) {
      const item = typeof rawItem === 'string' ? rawItem.trim() : '';
      if (!item || deduped.includes(item)) {
        continue;
      }
      deduped.push(item);
    }
    return deduped;
  }, [fallbackSrcs, src]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    setSourceIndex(0);
    setHasLoadError(false);
  }, [candidateSources]);

  const activeSrc = candidateSources[sourceIndex] ?? '';

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onDoubleClick?.(event);

    if (event.defaultPrevented || disableViewer) {
      return;
    }

    const fallbackSrc = event.currentTarget.currentSrc || activeSrc;
    const viewerSrc = typeof viewerSourceUrl === 'string' ? viewerSourceUrl.trim() : '';
    const viewerSourceAlreadyFailed =
      sourceIndex > 0 && viewerSrc.length > 0 && candidateSources.includes(viewerSrc) && viewerSrc !== activeSrc;
    const resolvedSource =
      viewerSrc && !viewerSourceAlreadyFailed
        ? viewerSrc
        : fallbackSrc.trim();
    if (!resolvedSource) {
      return;
    }

    event.stopPropagation();
    if (!resolvedSource.startsWith('asset-media:')) {
      openImageViewer(resolvedSource, normalizeViewerList(viewerImageList, resolvedSource));
      return;
    }
    // Browser asset-media references are durable handles; the viewer needs a session display URL.
    void resolveCanvasImageOriginalDisplayUrl(resolvedSource).then(
      (displayUrl) => openImageViewer(displayUrl, normalizeViewerList(viewerImageList, displayUrl)),
      (error: unknown) => console.warn('[CanvasNodeImage] original image is unavailable for the viewer', { error }),
    );
  }, [activeSrc, candidateSources, disableViewer, onDoubleClick, openImageViewer, sourceIndex, viewerImageList, viewerSourceUrl]);

  const handleError = useCallback((event: SyntheticEvent<HTMLImageElement, Event>) => {
    onError?.(event);
    setSourceIndex((currentIndex) => {
      const nextIndex = currentIndex + 1;
      if (nextIndex < candidateSources.length) {
        return nextIndex;
      }
      setHasLoadError(true);
      return currentIndex;
    });
  }, [candidateSources.length, onError]);

  if (!activeSrc && pending) {
    return (
      <div
        className={`bg-(--canvas-node-media-bg) ${className ?? ''}`}
        role="img"
        aria-label={typeof alt === 'string' ? alt : undefined}
        aria-busy="true"
      />
    );
  }

  if (!activeSrc || hasLoadError) {
    return (
      <div
        className={`flex items-center justify-center gap-1 bg-(--canvas-node-media-bg) text-[10px] leading-tight text-text-muted ${className ?? ''}`}
        role="img"
        aria-label={typeof alt === 'string' && alt.trim() ? alt : t('common.imageMissing')}
        title={t('common.imageMissing')}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate">{t('common.imageMissing')}</span>
      </div>
    );
  }

  return (
    <img
      decoding="async"
      {...props}
      src={activeSrc}
      alt={alt}
      className={className}
      onDoubleClick={handleDoubleClick}
      onError={handleError}
    />
  );
});

CanvasNodeImage.displayName = 'CanvasNodeImage';
