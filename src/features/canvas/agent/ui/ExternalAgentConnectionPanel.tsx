import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Clipboard,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import {
  createExternalAgentConnection,
  inspectExternalAgentConnection,
  listenExternalAgentEvents,
  replayExternalAgentPendingToolCalls,
  resolveExternalAgentToolCall,
  revokeExternalAgentConnection,
  type ExternalAgentConnectionInfo,
  type ExternalAgentProviderConfig,
  type ExternalAgentToolDefinition,
} from '@/commands/externalAgent';
import {
  prepareExternalAgentToolRequest,
  resolveExternalAgentToolApproval,
} from '../application/externalAgentCanvasBridge';
import {
  enqueueExternalAgentApproval,
  type ExternalAgentPendingApproval,
} from '../application/externalAgentApprovalQueue';
import type { ExternalAgentToolRequest } from '../domain/agentModel';

type ProviderTab = 'codex' | 'claude';

export interface ExternalAgentConnectionPanelProps {
  projectId: string | null;
  projectName: string | null;
  tools: ExternalAgentToolDefinition[];
  className?: string;
}

function formatDate(value: number | null, locale: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(value);
}

function destination(config: ExternalAgentProviderConfig): string {
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);
  return isWindows ? config.destinationWindows : config.destinationMacos;
}

export function ExternalAgentConnectionPanel({
  projectId,
  projectName,
  tools,
  className = '',
}: ExternalAgentConnectionPanelProps) {
  const { t, i18n } = useTranslation();
  const [connection, setConnection] = useState<ExternalAgentConnectionInfo | null>(null);
  const [provider, setProvider] = useState<ProviderTab>('codex');
  const [busy, setBusy] = useState<'create' | 'refresh' | 'revoke' | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<ExternalAgentPendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy('refresh');
    try {
      setConnection(await inspectExternalAgentConnection());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!silent) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = globalThis.setInterval(() => void refresh(true), 5_000);
    return () => globalThis.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const connectionId = connection?.connectionId;
    if (!connectionId || !projectId) return undefined;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenExternalAgentEvents(async (event) => {
      if (!active || event.sessionId !== connectionId || event.kind !== 'toolRequested' || !event.toolCall) return;
      const request: ExternalAgentToolRequest = {
        version: 1,
        runtime: event.runtime,
        sessionId: event.sessionId,
        turnId: event.turnId ?? `managed-${event.toolCall.callId}`,
        callId: event.toolCall.callId,
        toolName: event.toolCall.name as ExternalAgentToolRequest['toolName'],
        arguments: event.toolCall.input,
      };
      if (connection?.project?.id !== projectId) {
        await resolveExternalAgentToolCall({
          sessionId: request.sessionId,
          callId: request.callId,
          resolution: {
            outcome: 'error',
            errorCode: 'active_project_changed',
            message: t('canvasAgent.externalMcp.projectChangedResolution'),
          },
        }).catch(() => undefined);
        if (active) setError(t('canvasAgent.externalMcp.projectChanged'));
        return;
      }
      try {
        const approval = await prepareExternalAgentToolRequest({ projectId, request });
        if (active) setPendingApprovals((current) => enqueueExternalAgentApproval(current, {
            request,
            summary: approval.summary,
            impactSummary: approval.impact.summary,
          }));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await resolveExternalAgentToolCall({
          sessionId: request.sessionId,
          callId: request.callId,
          resolution: { outcome: 'error', errorCode: 'approval_prepare_failed', message },
        }).catch(() => undefined);
        if (active) setError(message);
      }
    }).then((dispose) => {
      if (active) {
        unlisten = dispose;
        void replayExternalAgentPendingToolCalls().catch((cause) => {
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        });
      } else dispose();
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [connection?.connectionId, connection?.project?.id, projectId, t]);

  const config = connection?.configs?.[provider] ?? null;
  const pendingApproval = pendingApprovals[0] ?? null;
  const canCreate = Boolean(projectId && projectName && tools.length > 0 && busy === null);
  const activeConnection = Boolean(connection?.connectionId);
  const statusClass = connection?.status === 'connected'
    ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300'
    : connection?.status === 'expired'
      ? 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300'
      : 'border-border-dark bg-text-dark/[0.035] text-text-muted';
  const scope = useMemo(() => connection?.scope.join('、') || '—', [connection?.scope]);

  const handleCreate = async () => {
    if (!projectId || !projectName) return;
    setBusy('create');
    setError(null);
    try {
      setConnection(await createExternalAgentConnection({ projectId, projectName, tools }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async () => {
    if (!connection?.connectionId) return;
    setBusy('revoke');
    setError(null);
    try {
      setConnection(await revokeExternalAgentConnection(connection.connectionId));
      setPendingApprovals([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.contents);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1_500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApproval = async (approve: boolean) => {
    if (!pendingApproval || !projectId) return;
    setApprovalBusy(true);
    setError(null);
    try {
      const result = await resolveExternalAgentToolApproval({
        projectId,
        request: pendingApproval.request,
        approve,
      });
      if (result.status === 'error') throw new Error(result.error ?? t('canvasAgent.externalMcp.executionFailed'));
      setPendingApprovals((current) => current.filter((item) => item.request.callId !== pendingApproval.request.callId));
      await refresh(true);
      await replayExternalAgentPendingToolCalls();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApprovalBusy(false);
    }
  };

  return (
    <section className={`rounded-xl border border-border-dark bg-surface-dark/55 p-4 ${className}`} aria-label={t('canvasAgent.externalMcp.title')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-dark">
            <Plug className="h-4 w-4 text-accent" />
            {t('canvasAgent.externalMcp.title')}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {t('canvasAgent.externalMcp.description')}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40"
          onClick={() => void refresh()}
          disabled={busy !== null}
          aria-label={t('canvasAgent.externalMcp.refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'motion-safe:animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <div className={`rounded-lg border px-3 py-2 ${statusClass}`}>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{t('canvasAgent.externalMcp.statusLabel')}</div>
          <div className="mt-1 font-medium">{t(`canvasAgent.externalMcp.status.${connection?.status ?? 'disconnected'}`)}</div>
        </div>
        <div className="rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-text-muted">
          <div className="text-[10px] uppercase tracking-wide">{t('canvasAgent.externalMcp.project')}</div>
          <div className="mt-1 truncate font-medium text-text-dark">
            {connection?.project?.name ?? projectName ?? t('canvasAgent.externalMcp.noProject')}
          </div>
        </div>
        <div className="rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-text-muted">
          <div className="text-[10px] uppercase tracking-wide">{t('canvasAgent.externalMcp.scope')}</div>
          <div className="mt-1 line-clamp-2 text-text-dark">{scope}</div>
        </div>
        <div className="rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-text-muted">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide">
            <ShieldCheck className="h-3 w-3" />{t('canvasAgent.externalMcp.approvalMode')}
          </div>
          <div className="mt-1 font-medium text-text-dark">{t('canvasAgent.externalMcp.manualApproval')}</div>
        </div>
      </div>

      {activeConnection ? (
        <>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[11px] leading-5 text-text-muted">
            <dt>{t('canvasAgent.externalMcp.expires')}</dt><dd className="text-text-dark">{formatDate(connection?.expiresAt ?? null, i18n.language)}</dd>
            <dt>{t('canvasAgent.externalMcp.connectedAt')}</dt><dd className="text-text-dark">{formatDate(connection?.connectedAt ?? null, i18n.language)}</dd>
            <dt>{t('canvasAgent.externalMcp.lastActivity')}</dt><dd className="text-text-dark">{formatDate(connection?.lastActivityAt ?? null, i18n.language)}</dd>
            <dt>{t('canvasAgent.externalMcp.calls')}</dt><dd className="text-text-dark">{connection?.callCount ?? 0}</dd>
          </dl>

          <div className="mt-4 flex rounded-lg border border-border-dark bg-bg-dark p-1" role="tablist" aria-label={t('canvasAgent.externalMcp.providerTabs')}>
            {(['codex', 'claude'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={provider === item}
                onClick={() => setProvider(item)}
                className={`h-9 flex-1 rounded-md text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${provider === item ? 'bg-text-dark/[0.08] text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
              >
                {item === 'codex' ? 'Codex' : 'Claude Code'}
              </button>
            ))}
          </div>

          {config ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                <span className="truncate">{t('canvasAgent.externalMcp.mergeConfig', { destination: destination(config) })}</span>
                <span className="shrink-0 uppercase">{config.format}</span>
              </div>
              <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-border-dark bg-black/[0.08] p-3 text-[11px] leading-5 text-text-dark dark:bg-black/20">{config.contents}</pre>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border-dark px-3 text-xs text-text-dark transition-colors duration-150 hover:bg-text-dark/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                  {copied ? t('canvasAgent.externalMcp.copied') : t('canvasAgent.externalMcp.copy')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={busy !== null}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-500/30 px-3 text-xs text-red-600 transition-colors duration-150 hover:bg-red-500/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:opacity-40 dark:text-red-300"
                >
                  {busy === 'revoke' ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                  {t('canvasAgent.externalMcp.revoke')}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/90 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'create' ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {t('canvasAgent.externalMcp.create')}
        </button>
      )}

      {pendingApproval ? (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3" role="alert">
          <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.externalMcp.approvalTitle')}</div>
          {pendingApprovals.length > 1 ? (
            <div className="mt-1 text-[10px] text-text-muted">
              {t('canvasAgent.externalMcp.pendingCount', { count: pendingApprovals.length })}
            </div>
          ) : null}
          <p className="mt-1 text-[11px] leading-5 text-text-muted">{pendingApproval.summary}</p>
          <div className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">{pendingApproval.impactSummary}</div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void handleApproval(false)}
              className="h-9 rounded-lg border border-border-dark px-3 text-xs text-text-muted hover:bg-text-dark/[0.05] disabled:opacity-40"
            >
              {t('canvasAgent.externalMcp.deny')}
            </button>
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void handleApproval(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white disabled:opacity-40"
            >
              {approvalBusy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
              {t('canvasAgent.externalMcp.approve')}
            </button>
          </div>
        </div>
      ) : null}

      {!projectId || !projectName ? (
        <p className="mt-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">{t('canvasAgent.externalMcp.openProjectFirst')}</p>
      ) : null}
      {error ? <p className="mt-3 break-words text-[11px] leading-5 text-red-600 dark:text-red-300" role="alert">{error}</p> : null}
    </section>
  );
}
