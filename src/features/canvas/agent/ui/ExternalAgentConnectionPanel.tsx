import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { ExternalAgentInstallCard } from './ExternalAgentInstallCard';
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
  ExternalAgentInvokeError,
  type ExternalAgentConnectionInfo,
  type ExternalAgentProviderConfig,
  type ExternalAgentToolDefinition,
} from '@/commands/externalAgent';
import { UiButton, UiIconButton } from '@/components/ui';
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

function describeError(cause: unknown, desktopOnly: string): string {
  if (cause instanceof ExternalAgentInvokeError && cause.code === 'runtime_unavailable') return desktopOnly;
  return cause instanceof Error ? cause.message : String(cause);
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
      setError(describeError(cause, t('rework.external.desktopOnly')));
    } finally {
      if (!silent) setBusy(null);
    }
  }, [t]);

  useEffect(() => {
    // Browser preview has no desktop runtime; the install card already explains the requirement.
    if (!isTauri()) return undefined;
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
          if (active) setError(describeError(cause, t('rework.external.desktopOnly')));
        });
      } else dispose();
    }).catch((cause) => {
      if (active) setError(describeError(cause, t('rework.external.desktopOnly')));
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
    ? 'border-success/30 bg-success/8 text-success'
    : connection?.status === 'expired'
      ? 'border-warning/30 bg-warning/8 text-warning'
      : 'border-[var(--line)] bg-[var(--field-bg)] text-text-muted';
  const scope = useMemo(() => connection?.scope.join('、') || '—', [connection?.scope]);

  const handleCreate = async () => {
    if (!projectId || !projectName) return;
    setBusy('create');
    setError(null);
    try {
      setConnection(await createExternalAgentConnection({ projectId, projectName, tools }));
    } catch (cause) {
      setError(describeError(cause, t('rework.external.desktopOnly')));
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
      setError(describeError(cause, t('rework.external.desktopOnly')));
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
      setError(describeError(cause, t('rework.external.desktopOnly')));
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
      setError(describeError(cause, t('rework.external.desktopOnly')));
    } finally {
      setApprovalBusy(false);
    }
  };

  return (
    <section className={`rounded-xl border border-[var(--line)] bg-surface/55 p-4 ${className}`} aria-label={t('canvasAgent.externalMcp.title')}>
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
        <UiIconButton
          onClick={() => void refresh()}
          disabled={busy !== null}
          aria-label={t('canvasAgent.externalMcp.refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'motion-safe:animate-spin' : ''}`} />
        </UiIconButton>
      </div>

      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <div className={`rounded-lg border px-3 py-2 ${statusClass}`}>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{t('canvasAgent.externalMcp.statusLabel')}</div>
          <div className="mt-1 font-medium">{t(`canvasAgent.externalMcp.status.${connection?.status ?? 'disconnected'}`)}</div>
        </div>
        <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] px-3 py-2 text-text-muted">
          <div className="text-[10px] uppercase tracking-wide">{t('canvasAgent.externalMcp.project')}</div>
          <div className="mt-1 truncate font-medium text-text-dark">
            {connection?.project?.name ?? projectName ?? t('canvasAgent.externalMcp.noProject')}
          </div>
        </div>
        <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] px-3 py-2 text-text-muted">
          <div className="text-[10px] uppercase tracking-wide">{t('canvasAgent.externalMcp.scope')}</div>
          <div className="mt-1 line-clamp-2 text-text-dark">{scope}</div>
        </div>
        <div className="rounded-lg border border-[var(--line)] bg-[var(--field-bg)] px-3 py-2 text-text-muted">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide">
            <ShieldCheck className="h-3 w-3" />{t('canvasAgent.externalMcp.approvalMode')}
          </div>
          <div className="mt-1 font-medium text-text-dark">{t('canvasAgent.externalMcp.manualApproval')}</div>
        </div>
      </div>

      {activeConnection ? (
        <>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px] leading-5 text-text-muted">
            <dt>{t('canvasAgent.externalMcp.expires')}</dt><dd className="text-text-dark">{connection?.expiresAt ? formatDate(connection.expiresAt, i18n.language) : t('rework.external.lifetime')}</dd>
            <dt>{t('canvasAgent.externalMcp.connectedAt')}</dt><dd className="text-text-dark">{formatDate(connection?.connectedAt ?? null, i18n.language)}</dd>
            <dt>{t('canvasAgent.externalMcp.lastActivity')}</dt><dd className="text-text-dark">{formatDate(connection?.lastActivityAt ?? null, i18n.language)}</dd>
            <dt>{t('canvasAgent.externalMcp.calls')}</dt><dd className="text-text-dark">{connection?.callCount ?? 0}</dd>
          </dl>

          <div className="mt-4 flex rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-1" role="tablist" aria-label={t('canvasAgent.externalMcp.providerTabs')}>
            {(['codex', 'claude'] as const).map((item) => (
              <UiButton
                variant="ghost"
                key={item}
                type="button"
                role="tab"
                aria-selected={provider === item}
                onClick={() => setProvider(item)}
                className={`h-9 flex-1 rounded-md text-xs ${provider === item ? 'bg-[var(--press)] text-text-dark' : ''}`}
              >
                {item === 'codex' ? 'Codex' : 'Claude Code'}
              </UiButton>
            ))}
          </div>

          {config ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                <span className="truncate">{t('canvasAgent.externalMcp.mergeConfig', { destination: destination(config) })}</span>
                <span className="shrink-0 uppercase">{config.format}</span>
              </div>
              <pre className="ui-scrollbar mt-2 max-h-56 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3 text-[11px] leading-5 text-text-dark">{config.contents}</pre>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <UiButton
                  variant="secondary"
                  onClick={() => void handleCopy()}
                  className="h-9 gap-1.5 text-xs"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                  {copied ? t('canvasAgent.externalMcp.copied') : t('canvasAgent.externalMcp.copy')}
                </UiButton>
                <UiButton
                  variant="danger"
                  onClick={() => void handleRevoke()}
                  disabled={busy !== null}
                  className="h-9 gap-1.5 text-xs"
                >
                  {busy === 'revoke' ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                  {t('canvasAgent.externalMcp.revoke')}
                </UiButton>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <UiButton
          variant="primary"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          className="mt-4 h-10 w-full gap-2 text-xs"
        >
          {busy === 'create' ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {t('canvasAgent.externalMcp.create')}
        </UiButton>
      )}
      <div className="mt-3"><ExternalAgentInstallCard cli={provider} connected={activeConnection} /></div>

      {pendingApproval ? (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/[0.07] p-3" role="alert">
          <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.externalMcp.approvalTitle')}</div>
          {pendingApprovals.length > 1 ? (
            <div className="mt-1 text-[10px] text-text-muted">
              {t('canvasAgent.externalMcp.pendingCount', { count: pendingApprovals.length })}
            </div>
          ) : null}
          <p className="mt-1 text-[11px] leading-5 text-text-muted">{pendingApproval.summary}</p>
          <div className="mt-2 text-[10px] text-warning">{pendingApproval.impactSummary}</div>
          <div className="mt-3 flex justify-end gap-2">
            <UiButton
              variant="secondary"
              disabled={approvalBusy}
              onClick={() => void handleApproval(false)}
              className="h-9 text-xs"
            >
              {t('canvasAgent.externalMcp.deny')}
            </UiButton>
            <UiButton
              variant="primary"
              disabled={approvalBusy}
              onClick={() => void handleApproval(true)}
              className="h-9 gap-1.5 text-xs"
            >
              {approvalBusy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
              {t('canvasAgent.externalMcp.approve')}
            </UiButton>
          </div>
        </div>
      ) : null}

      {!projectId || !projectName ? (
        <p className="mt-3 text-[11px] leading-5 text-warning">{t('canvasAgent.externalMcp.openProjectFirst')}</p>
      ) : null}
      {error ? <p className="mt-3 wrap-break-word text-[11px] leading-5 text-danger" role="alert">{error}</p> : null}
    </section>
  );
}
