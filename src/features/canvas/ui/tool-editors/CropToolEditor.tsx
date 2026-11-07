import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

import { UiChipButton, UiInput } from '@/components/ui';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { ToolSelectField } from '@/features/canvas/tools';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 20;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;

function parsePresetRatio(value: string): number | null {
  if (!value.includes(':')) {
    return null;
  }

  const [rawW, rawH] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return null;
  }

  return rawW / rawH;
}

function parseCustomRatio(value: string): number | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (input.includes(':')) {
    return parsePresetRatio(input);
  }

  const numeric = Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toImageSpaceCrop(
  crop: PixelCrop,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
) {
  const scaleX = naturalWidth / renderedWidth;
  const scaleY = naturalHeight / renderedHeight;

  return {
    cropX: Math.round(crop.x * scaleX),
    cropY: Math.round(crop.y * scaleY),
    cropWidth: Math.round(crop.width * scaleX),
    cropHeight: Math.round(crop.height * scaleY),
  };
}

function toRenderedCrop(
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
): Crop {
  const scaleX = renderedWidth / naturalWidth;
  const scaleY = renderedHeight / naturalHeight;

  return {
    unit: 'px',
    x: Math.max(0, cropX * scaleX),
    y: Math.max(0, cropY * scaleY),
    width: Math.max(1, cropWidth * scaleX),
    height: Math.max(1, cropHeight * scaleY),
  };
}

function buildDefaultCrop(width: number, height: number, aspect: number | undefined): Crop {
  if (!aspect) {
    return { unit: 'px', x: 0, y: 0, width, height };
  }

  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 88,
      },
      aspect,
      width,
      height
    ),
    width,
    height
  );
}

export function CropToolEditor({ plugin, sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousAspectKeyRef = useRef<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [customRatioInput, setCustomRatioInput] = useState(
    typeof options.customAspectRatio === 'string' ? options.customAspectRatio : ''
  );
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const displaySourceImageUrl = useMemo(
    () => resolveImageDisplayUrl(sourceImageUrl),
    [sourceImageUrl]
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const renderedImageSize = useMemo(() => {
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / naturalSize.width, maxHeight / naturalSize.height, 1);

    return {
      width: Math.max(1, Math.round(naturalSize.width * ratio)),
      height: Math.max(1, Math.round(naturalSize.height * ratio)),
    };
  }, [naturalSize.height, naturalSize.width, viewportSize.height, viewportSize.width]);

  const ratioOptions = useMemo(() => {
    const field = plugin.fields.find((item) => item.type === 'select' && item.key === 'aspectRatio');
    if (!field) {
      return [
        { label: '自由', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '4:5', value: '4:5' },
        { label: '5:4', value: '5:4' },
        { label: '2:1', value: '2:1' },
        { label: '21:9', value: '21:9' },
        { label: '原图', value: 'original' },
      ];
    }

    return (field as ToolSelectField).options;
  }, [plugin.fields]);

  const aspectMode = typeof options.aspectRatio === 'string' ? options.aspectRatio : 'free';
  const resolvedAspect = useMemo(() => {
    if (aspectMode === 'free') {
      return undefined;
    }

    if (aspectMode === 'original') {
      if (naturalSize.width <= 0 || naturalSize.height <= 0) {
        return undefined;
      }
      return naturalSize.width / naturalSize.height;
    }

    if (aspectMode === 'custom') {
      return parseCustomRatio(customRatioInput) ?? undefined;
    }

    return parsePresetRatio(aspectMode) ?? undefined;
  }, [aspectMode, customRatioInput, naturalSize.height, naturalSize.width]);

  const customRatioError = useMemo(() => {
    if (aspectMode !== 'custom') {
      return null;
    }
    if (!customRatioInput.trim()) {
      return '请输入比例，例如 3:2 或 1.5';
    }
    if (!parseCustomRatio(customRatioInput)) {
      return '比例格式无效';
    }
    return null;
  }, [aspectMode, customRatioInput]);

  useEffect(() => {
    setCustomRatioInput(typeof options.customAspectRatio === 'string' ? options.customAspectRatio : '');
  }, [options.customAspectRatio]);

  const syncCropToOptions = useCallback((pixelCrop: PixelCrop) => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return;
    }

    const imageCrop = toImageSpaceCrop(
      pixelCrop,
      renderedImageSize.width,
      renderedImageSize.height,
      naturalSize.width,
      naturalSize.height
    );

    onOptionsChange({
      ...options,
      aspectRatio: aspectMode,
      customAspectRatio: customRatioInput,
      ...imageCrop,
    });
  }, [
    aspectMode,
    customRatioInput,
    naturalSize.height,
    naturalSize.width,
    onOptionsChange,
    options,
    renderedImageSize,
  ]);

  const applyCropFromOptions = useCallback((): boolean => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return false;
    }

    const cropX = toNumber(options.cropX);
    const cropY = toNumber(options.cropY);
    const cropWidth = toNumber(options.cropWidth);
    const cropHeight = toNumber(options.cropHeight);
    if (
      cropX === null ||
      cropY === null ||
      cropWidth === null ||
      cropHeight === null ||
      cropWidth <= 0 ||
      cropHeight <= 0
    ) {
      return false;
    }

    setCrop(
      toRenderedCrop(
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        renderedImageSize.width,
        renderedImageSize.height,
        naturalSize.width,
        naturalSize.height
      )
    );
    return true;
  }, [naturalSize.height, naturalSize.width, options.cropHeight, options.cropWidth, options.cropX, options.cropY, renderedImageSize]);

  useEffect(() => {
    if (!renderedImageSize) {
      return;
    }

    const aspectKey = `${aspectMode}:${aspectMode === 'custom' ? customRatioInput : ''}`;
    const aspectModeChanged =
      previousAspectKeyRef.current !== null
      && previousAspectKeyRef.current !== aspectKey;
    previousAspectKeyRef.current = aspectKey;

    if (!aspectModeChanged && applyCropFromOptions()) {
      return;
    }

    const next = buildDefaultCrop(
      renderedImageSize.width,
      renderedImageSize.height,
      resolvedAspect
    );
    setCrop(next);
    syncCropToOptions({
      unit: 'px',
      x: Math.round(next.x ?? 0),
      y: Math.round(next.y ?? 0),
      width: Math.round(next.width ?? renderedImageSize.width),
      height: Math.round(next.height ?? renderedImageSize.height),
    });
  }, [
    applyCropFromOptions,
    aspectMode,
    customRatioInput,
    renderedImageSize,
    resolvedAspect,
    syncCropToOptions,
  ]);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) {
      return;
    }

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {ratioOptions.map((item) => {
          const active = item.value === aspectMode;
          return (
            <UiChipButton active={active}
              key={item.value}
              type="button"
              className="rounded-lg px-3 py-1.5 text-xs"
              onClick={() =>
                onOptionsChange({
                  ...options,
                  aspectRatio: item.value,
                })
              }
            >
              {item.label}
            </UiChipButton>
          );
        })}

        <UiChipButton active={aspectMode === 'custom'}
          type="button"
          className="rounded-lg px-3 py-1.5 text-xs"
          onClick={() =>
            onOptionsChange({
              ...options,
              aspectRatio: 'custom',
            })
          }
        >
          自定义
        </UiChipButton>
      </div>

      {aspectMode === 'custom' && (
        <div className="flex items-center gap-2">
          <UiInput
            type="text"
            value={customRatioInput}
            onChange={(event) => {
              const next = event.target.value;
              setCustomRatioInput(next);
              onOptionsChange({
                ...options,
                aspectRatio: 'custom',
                customAspectRatio: next,
              });
            }}
            placeholder="输入比例，如 3:2 或 1.5"
            className="h-9 w-[220px] rounded-lg px-3 text-sm"
          />
          {customRatioError && <span className="text-xs text-danger">{customRatioError}</span>}
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative h-[min(62vh,640px)] rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-media-bg)"
      >
        <div className="flex h-full w-full items-center justify-center p-3">
          {renderedImageSize && (
            <ReactCrop
              crop={crop}
              onChange={(nextCrop) => setCrop(nextCrop)}
              onComplete={(pixelCrop) => syncCropToOptions(pixelCrop)}
              aspect={resolvedAspect}
              minWidth={24}
              minHeight={24}
              keepSelection
              ruleOfThirds
            >
              <img
                ref={imageRef}
                src={displaySourceImageUrl}
                alt="Crop Source"
                className="block select-none object-contain"
                style={{
                  width: `${renderedImageSize.width}px`,
                  height: `${renderedImageSize.height}px`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
                onLoad={handleImageLoad}
              />
            </ReactCrop>
          )}
          {!renderedImageSize && (
            <img
              ref={imageRef}
              src={displaySourceImageUrl}
              alt="Crop Source"
              className="hidden"
              onLoad={handleImageLoad}
            />
          )}
        </div>
      </div>
    </div>
  );
}
