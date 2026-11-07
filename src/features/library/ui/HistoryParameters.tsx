import { useTranslation } from 'react-i18next';
import type { GenerationHistoryRecord } from '../history/history';

/** Human-readable facts first; the existing raw diagnostics remain available below. */
export function HistoryParameters({ record }: { record: GenerationHistoryRecord }) {
  const { t } = useTranslation();
  const config = record.params.config;
  const facts = [
    [t('ui.viewer.model'), record.modelRef],
    [t('ui.library.mode'), record.modeId],
    [t('ui.library.ratio'), config?.aspectRatio],
    [t('ui.library.size'), config?.size],
    [t('ui.library.duration'), config?.seconds === undefined ? undefined : `${config.seconds}s`],
    [t('ui.library.count'), record.outputs.length.toString()],
    [t('ui.library.references'), record.references.length.toString()],
  ].filter((entry) => entry[1] !== undefined && entry[1] !== '');
  return <dl className="grid gap-x-6 gap-y-3 rounded-xl bg-raised p-4 text-sm sm:grid-cols-2">{facts.map(([label, value]) => <div key={label} className="flex min-w-0 justify-between gap-4"><dt className="shrink-0 text-text-subtle">{label}</dt><dd className="min-w-0 break-words text-right text-text">{value}</dd></div>)}</dl>;
}
