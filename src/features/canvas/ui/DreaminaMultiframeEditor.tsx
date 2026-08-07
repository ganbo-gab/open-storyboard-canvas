import { ArrowRight, Clock3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DREAMINA_MULTIFRAME_CAPABILITY,
  resizeDreaminaTransitionSegments,
  type DreaminaTransitionSegment,
} from '@/features/canvas/application/dreaminaCapabilities';

type DreaminaMultiframeEditorProps = {
  imageCount: number;
  value: unknown;
  onChange: (segments: DreaminaTransitionSegment[]) => void;
};

export function DreaminaMultiframeEditor({
  imageCount,
  value,
  onChange,
}: DreaminaMultiframeEditorProps) {
  const { t } = useTranslation();
  const expectedCount = Math.max(0, imageCount - 1);
  const normalizedSegments = useMemo(
    () => resizeDreaminaTransitionSegments(value, expectedCount),
    [expectedCount, value],
  );
  const [segments, setSegments] = useState(normalizedSegments);

  useEffect(() => {
    setSegments(normalizedSegments);
  }, [normalizedSegments]);

  const usesCustomDurations = segments.some(({ duration }) => duration !== undefined);
  const defaultDuration = Math.max(
    DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.min,
    Math.min(DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.max, 2),
  );

  const commit = (next: DreaminaTransitionSegment[]) => {
    const normalized = next.map((segment) => ({
      prompt: segment.prompt,
      ...(usesCustomDurations
        ? { duration: segment.duration ?? defaultDuration }
        : {}),
    }));
    setSegments(normalized);
    onChange(normalized);
  };

  const toggleCustomDurations = () => {
    const next = segments.map((segment) => ({
      prompt: segment.prompt,
      ...(!usesCustomDurations ? { duration: segment.duration ?? defaultDuration } : {}),
    }));
    setSegments(next);
    onChange(next);
  };

  return (
    <section className="space-y-2 border-t border-[var(--canvas-node-field-border)] pt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-text-dark">
            {t('node.aiVideo.multiframeTransitions', { count: expectedCount })}
          </div>
          <div className="mt-0.5 text-[10px] leading-4 text-text-muted">
            {t('node.aiVideo.multiframeHint')}
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] text-text-muted">
          <input
            type="checkbox"
            checked={usesCustomDurations}
            onChange={toggleCustomDurations}
            className="nodrag nowheel h-3.5 w-3.5 accent-accent"
          />
          <Clock3 className="h-3 w-3" />
          {t('node.aiVideo.segmentDurations')}
        </label>
      </div>

      <div className="space-y-1.5">
        {segments.map((segment, index) => (
          <div
            key={index}
            className="rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2"
          >
            <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-text-muted">
              <span>{t('node.aiVideo.frameLabel', { index: index + 1 })}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span>{t('node.aiVideo.frameLabel', { index: index + 2 })}</span>
            </div>
            <div className="flex items-start gap-2">
              <textarea
                value={segment.prompt}
                rows={2}
                onChange={(event) => {
                  const next = segments.map((item) => ({ ...item }));
                  next[index].prompt = event.target.value;
                  setSegments(next);
                }}
                onBlur={() => commit(segments)}
                placeholder={t('node.aiVideo.transitionPromptPlaceholder', {
                  from: index + 1,
                  to: index + 2,
                })}
                aria-label={t('node.aiVideo.transitionPromptLabel', {
                  from: index + 1,
                  to: index + 2,
                })}
                className="nodrag nowheel min-h-[48px] min-w-0 flex-1 resize-y rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1.5 text-[11px] leading-4 text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus:border-accent/60"
              />
              {usesCustomDurations && (
                <label className="w-[66px] shrink-0 text-[10px] text-text-muted">
                  <span className="mb-1 block">{t('node.aiVideo.segmentSeconds')}</span>
                  <input
                    type="number"
                    min={DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.min}
                    max={DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.max}
                    step={1}
                    value={segment.duration ?? defaultDuration}
                    onChange={(event) => {
                      const next = segments.map((item) => ({ ...item }));
                      const rawDuration = Number(event.target.value);
                      next[index].duration = Number.isFinite(rawDuration)
                        ? Math.max(
                          DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.min,
                          Math.min(
                            DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration.max,
                            Math.round(rawDuration),
                          ),
                        )
                        : defaultDuration;
                      commit(next);
                    }}
                    className="nodrag nowheel h-8 w-full rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 text-[11px] text-text-dark outline-none focus:border-accent/60"
                  />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
