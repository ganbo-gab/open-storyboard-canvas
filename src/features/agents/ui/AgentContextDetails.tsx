import { useTranslation } from 'react-i18next';
import type { AgentContextUsage } from '@/features/canvas/agent/application/agentContextUsage';

export function compactAgentTokenCount(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(Math.round(value));
}
export function formatAgentContextPercent(used: number, limit: number | null | undefined): string {
  if (!limit) return '—';
  const percent = used / limit * 100;
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent < 1 ? Number(percent.toFixed(1)) : Math.round(percent)}%`;
}
export function AgentContextDetails({ usage, contextWindow, draftTokens = 0, modelId }: {
  usage?: AgentContextUsage; contextWindow?: number | null; draftTokens?: number; modelId?: string;
}) {
  const { t } = useTranslation();
  const current = usage && (!modelId || usage.modelId === modelId) ? usage : undefined;
  if (!current) return <div className="px-1 py-2 text-xs leading-6 text-text-muted"><p>{t('canvasAgent.context.empty')}</p>{draftTokens > 0 ? <p>{t('canvasAgent.context.draft', { tokens: compactAgentTokenCount(draftTokens) })}</p> : null}</div>;
  const percent = contextWindow ? current.usedTokens / contextWindow * 100 : null;
  const parts = (['system', 'tools', 'conversation', 'media'] as const).filter(key => current.breakdown[key] > 0);
  return <div className="agent-context-details">
    <div className="flex items-center justify-between gap-4 text-sm"><span className="text-text-muted">{t('canvasAgent.context.lastInput')} {percent === null ? '' : `${formatAgentContextPercent(current.usedTokens, contextWindow)}`}</span><strong className="font-medium tabular-nums">{current.basis === 'estimated' ? '~' : ''}{compactAgentTokenCount(current.usedTokens)} / {contextWindow ? compactAgentTokenCount(contextWindow) : '—'}</strong></div>
    <div className="my-4 flex h-1.5 overflow-hidden rounded-full bg-text-dark/8" aria-hidden="true">{parts.map(key => <span key={key} className={`agent-context-swatch is-${key}`} style={{ width: `${current.breakdown[key] / (contextWindow ?? Math.max(1, current.usedTokens)) * 100}%` }} />)}</div>
    <dl className="space-y-2.5">{parts.map(key => <div key={key} className="flex items-center gap-2 text-xs"><span className={`agent-context-swatch is-${key} h-2.5 w-2.5 shrink-0 rounded-sm`} /><dt className="flex-1 text-text-muted">{t(`canvasAgent.context.${key}`)}</dt><dd className="tabular-nums">~{compactAgentTokenCount(current.breakdown[key])}</dd></div>)}</dl>
    <p className="mt-4 text-[11px] leading-5 text-text-muted">{t(current.basis === 'provider' ? 'canvasAgent.context.providerNote' : 'canvasAgent.context.estimateNote')}</p>
    {current.cachedTokens > 0 ? <p className="mt-1 text-[11px] text-text-muted">{t('canvasAgent.context.cache', { tokens: compactAgentTokenCount(current.cachedTokens), percent: Math.round(current.cachedTokens / current.usedTokens * 100) })}</p> : null}
    {draftTokens > 0 ? <p className="mt-1 text-[11px] text-text-muted">{t('canvasAgent.context.draft', { tokens: compactAgentTokenCount(draftTokens) })}</p> : null}
  </div>;
}
