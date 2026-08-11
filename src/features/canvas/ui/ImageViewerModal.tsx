import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useImageViewerTransform } from '../hooks/useImageViewerTransform';

export interface ImageViewerModalProps {
  open: boolean;
  imageUrl: string;
  imageList: string[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
}

export function ImageViewerModal({
  open,
  imageUrl,
  imageList,
  currentIndex,
  onClose,
  onNavigate,
}: ImageViewerModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const viewerControlClass =
    'inline-flex h-10 items-center justify-center rounded-full border border-white/20 bg-black/60 px-4 text-sm text-white backdrop-blur-xl';
  const { shouldRender, isVisible } = useDialogTransition(open, UI_DIALOG_TRANSITION_MS);
  const [displayImageUrl, setDisplayImageUrl] = useState(imageUrl);
  const { dialogRef, onKeyDown: onModalKeyDown } = useModalFocus({
    isOpen: open && shouldRender,
    onClose,
  });

  const {
    containerRef,
    imageRef,
    scaleDisplayRef,
    viewerOpacity,
    resetView,
    handleImageMouseDown,
    handleContainerMouseMove,
    handleContainerMouseUp,
    handleImageMouseMove,
    handleImageLoad,
    isPointOnImageContent,
  } = useImageViewerTransform(open && shouldRender);

  useEffect(() => {
    if (!shouldRender) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [shouldRender]);

  useEffect(() => {
    if (open && imageUrl) {
      setDisplayImageUrl(imageUrl);
    }
  }, [open, imageUrl]);

  useEffect(() => {
    if (!open) return;
    resetView();
  }, [open, imageUrl, resetView]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (currentIndex > 0) {
        onNavigate('prev');
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      if (currentIndex < imageList.length - 1) {
        onNavigate('next');
      }
      return;
    }
    onModalKeyDown(event);
  }, [currentIndex, imageList.length, onModalKeyDown, onNavigate]);

  if (!shouldRender) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('viewer.imageAlt')}
      tabIndex={-1}
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] overflow-hidden bg-black/90 backdrop-blur-lg transition-opacity duration-[180ms] ${isVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden p-4"
        style={{ overscrollBehavior: 'contain' }}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="relative">
          <img
            ref={imageRef}
            src={displayImageUrl}
            alt={t('viewer.imageAlt', '图片')}
            className="select-none transition-opacity duration-[180ms]"
            style={{
              opacity: viewerOpacity,
              transformOrigin: 'center',
              width: '95vw',
              height: '95vh',
              objectFit: 'contain',
            }}
            onLoad={handleImageLoad}
            onMouseDown={handleImageMouseDown}
            onMouseMove={handleImageMouseMove}
            onClick={(e) => {
              if (isPointOnImageContent(e.clientX, e.clientY)) {
                e.stopPropagation();
              } else {
                onClose();
              }
            }}
            draggable={false}
          />
        </div>

        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
          {imageList.length > 1 && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onNavigate('prev')}
                disabled={currentIndex <= 0}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800/80 text-white backdrop-blur-sm transition-[background-color,opacity] duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t('viewer.prev', '上一张')}
                title={t('viewer.prev', '上一张')}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('next')}
                disabled={currentIndex >= imageList.length - 1}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800/80 text-white backdrop-blur-sm transition-[background-color,opacity] duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t('viewer.next', '下一张')}
                title={t('viewer.next', '下一张')}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            {imageList.length > 1 && (
              <div className={viewerControlClass}>
                {currentIndex + 1} / {imageList.length}
              </div>
            )}
            <div
              ref={scaleDisplayRef}
              className={`${viewerControlClass} min-w-[74px]`}
            >
              100%
            </div>
            <button
              type="button"
              onClick={resetView}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              aria-label={t('viewer.reset', '重置视图')}
              title={t('viewer.reset', '重置视图')}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              aria-label={t('common.close', '关闭')}
              title={t('common.close', '关闭')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
