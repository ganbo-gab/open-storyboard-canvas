import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  CircleHelp,
  Copy,
  ExternalLink,
  FolderCog,
  KeyRound,
  Loader2,
  RefreshCw,
  Terminal,
  WalletCards,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiIconButton, UiPanel, UiSelect } from '@/components/ui/primitives';
import {
  useSettingsStore,
  type DreaminaStatusSnapshot,
} from '@/stores/settingsStore';

interface BackendStatus {
  installed: boolean;
  loggedIn: boolean;
  credits: number | null;
  error: string | null;
  networkDegraded: boolean;
  resolvedPath: string | null;
  versionInfo: {
    version: string | null;
    commit: string | null;
    buildTime: string | null;
  } | null;
  loginState: 'logged_in' | 'logged_out' | 'unknown';
  vipLevel: string | null;
  accountError: string | null;
  sessionsAvailable: boolean;
  sessionError: string | null;
}

interface DreaminaSession {
  id: number;
  name: string;
  isDefault: boolean;
}

interface DreaminaSessionListResult {
  ok: boolean;
  sessions: DreaminaSession[];
  error: string | null;
}

interface OAuthStartResult {
  ok: boolean;
  alreadyAuthorized: boolean;
  verificationUri: string | null;
  userCode: string | null;
  deviceCode: string | null;
  expiresIn: number | null;
  interval: number | null;
  error: string | null;
}

interface OAuthCheckResult {
  ok: boolean;
  authorized: boolean;
  pending: boolean;
  error: string | null;
}

interface NetworkStage {
  ok: boolean;
  detail: string;
}

interface NetworkDiagnoseResult {
  dns: NetworkStage;
  tcp: NetworkStage;
  tls: NetworkStage;
  http: NetworkStage;
  overallAdvice: string;
}

type MetricTone = 'neutral' | 'success' | 'warning' | 'danger';

function StatusMetric({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: MetricTone;
}) {
  const toneClass = tone === 'success'
    ? 'text-emerald-500'
    : tone === 'warning'
      ? 'text-amber-500'
      : tone === 'danger'
        ? 'text-red-500'
        : 'text-text-muted';
  return (
    <div className="min-w-0 border-b border-border-dark/60 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:px-4 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className={toneClass}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="mt-1 truncate text-sm font-medium text-text-dark" title={value}>{value}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-text-muted" title={detail}>{detail}</div>}
    </div>
  );
}

function snapshotFromBackend(status: BackendStatus): DreaminaStatusSnapshot {
  return {
    installed: status.installed,
    loggedIn: status.loggedIn,
    loginState: status.loginState,
    credits: status.credits,
    networkDegraded: status.networkDegraded,
    resolvedPath: status.resolvedPath,
    version: status.versionInfo?.version ?? null,
    commit: status.versionInfo?.commit ?? null,
    buildTime: status.versionInfo?.buildTime ?? null,
    vipLevel: status.vipLevel,
    accountError: status.accountError ?? status.error,
    sessionsAvailable: status.sessionsAvailable,
    sessionError: status.sessionError,
  };
}

export const DreaminaSection = memo(() => {
  const { t } = useTranslation();
  const desktopRuntime = isTauri();
  const status = useSettingsStore((state) => state.dreaminaStatus);
  const selectedSessionId = useSettingsStore((state) => state.dreaminaDefaultSessionId);
  const setSelectedSessionId = useSettingsStore((state) => state.setDreaminaDefaultSessionId);
  const [sessions, setSessions] = useState<DreaminaSession[]>([
    { id: 0, name: t('settings.dreamina.sessions.defaultName'), isDefault: true },
  ]);
  const [checking, setChecking] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [oauth, setOAuth] = useState<OAuthStartResult | null>(null);
  const [oauthStarting, setOAuthStarting] = useState(false);
  const [oauthChecking, setOAuthChecking] = useState(false);
  const [oauthPending, setOAuthPending] = useState(false);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnose, setDiagnose] = useState<NetworkDiagnoseResult | null>(null);

  const refreshSessions = useCallback(async () => {
    if (!desktopRuntime) return;
    setSessionLoading(true);
    try {
      const result = await invoke<DreaminaSessionListResult>('dreamina_session_list', { limit: 100 });
      setSessions(result.sessions.length > 0
        ? result.sessions
        : [{ id: 0, name: t('settings.dreamina.sessions.defaultName'), isDefault: true }]);
      setSessionError(result.ok ? null : (result.error ?? t('settings.dreamina.sessions.unavailable')));
    } catch (error) {
      setSessions([{ id: 0, name: t('settings.dreamina.sessions.defaultName'), isDefault: true }]);
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionLoading(false);
    }
  }, [desktopRuntime, t]);

  const refreshStatus = useCallback(async () => {
    if (!desktopRuntime) return;
    setChecking(true);
    try {
      const backend = await invoke<BackendStatus>('check_dreamina_login');
      useSettingsStore.getState().setDreaminaStatus(snapshotFromBackend(backend));
      if (backend.installed) {
        await refreshSessions();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useSettingsStore.getState().setDreaminaStatus({
        installed: false,
        loggedIn: false,
        loginState: 'unknown',
        credits: null,
        networkDegraded: false,
        resolvedPath: null,
        version: null,
        commit: null,
        buildTime: null,
        vipLevel: null,
        accountError: message,
        sessionsAvailable: false,
        sessionError: null,
      });
    } finally {
      setChecking(false);
    }
  }, [desktopRuntime, refreshSessions]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const startOAuth = useCallback(async () => {
    setOAuthStarting(true);
    setOAuthError(null);
    setOAuthPending(false);
    try {
      const result = await invoke<OAuthStartResult>('dreamina_oauth_start');
      if (!result.ok) {
        setOAuthError(result.error ?? t('settings.dreamina.oauth.startFailed'));
        return;
      }
      if (result.alreadyAuthorized) {
        setOAuth(null);
        await refreshStatus();
        return;
      }
      setOAuth(result);
    } catch (error) {
      setOAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setOAuthStarting(false);
    }
  }, [refreshStatus, t]);

  const checkOAuth = useCallback(async () => {
    if (!oauth?.deviceCode) return;
    setOAuthChecking(true);
    setOAuthError(null);
    try {
      const result = await invoke<OAuthCheckResult>('dreamina_oauth_check', {
        deviceCode: oauth.deviceCode,
        pollSeconds: 30,
      });
      if (result.authorized) {
        setOAuth(null);
        setOAuthPending(false);
        await refreshStatus();
        return;
      }
      setOAuthPending(result.pending);
      if (!result.ok) {
        setOAuthError(result.error ?? t('settings.dreamina.oauth.checkFailed'));
      }
    } catch (error) {
      setOAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setOAuthChecking(false);
    }
  }, [oauth?.deviceCode, refreshStatus, t]);

  const runNetworkDiagnose = useCallback(async () => {
    if (!desktopRuntime) return;
    setDiagnosing(true);
    setDiagnose(null);
    try {
      setDiagnose(await invoke<NetworkDiagnoseResult>('dreamina_network_diagnose'));
    } catch (error) {
      setDiagnose({
        dns: { ok: false, detail: t('settings.dreamina.network.commandFailed') },
        tcp: { ok: false, detail: '' },
        tls: { ok: false, detail: '' },
        http: { ok: false, detail: '' },
        overallAdvice: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDiagnosing(false);
    }
  }, [desktopRuntime, t]);

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }, []);

  if (!desktopRuntime) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-semibold text-text-dark">{t('settings.dreamina.title')}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">
            {t('settings.dreamina.description')}
          </p>
        </div>
        <UiPanel className="flex items-start gap-3 p-4" role="status">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-dark">
              {t('settings.dreamina.runtime.desktopOnlyTitle')}
            </div>
            <div className="mt-1 text-xs leading-5 text-text-muted">
              {t('settings.dreamina.runtime.desktopOnlyDescription')}
            </div>
          </div>
        </UiPanel>
      </div>
    );
  }

  const cliTone: MetricTone = status?.installed ? 'success' : status ? 'danger' : 'neutral';
  const accountTone: MetricTone = status?.loggedIn
    ? (status.networkDegraded ? 'warning' : 'success')
    : status?.loginState === 'unknown' ? 'warning' : status ? 'danger' : 'neutral';
  const sessionKnown = sessions.some((session) => session.id === selectedSessionId);
  const effectiveSessionError = sessionError
    ?? status?.sessionError
    ?? (!sessionKnown ? t('settings.dreamina.sessions.selectedMissing') : null);
  const accountLabel = status?.loggedIn
    ? t('settings.dreamina.status.loggedIn')
    : status?.loginState === 'logged_out'
      ? t('settings.dreamina.status.loggedOut')
      : t('settings.dreamina.status.unknown');
  const versionParts = [status?.commit, status?.buildTime].filter(Boolean);
  const versionDetail = versionParts.length > 0 ? versionParts.join(' · ') : undefined;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">{t('settings.dreamina.title')}</h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">
          {t('settings.dreamina.description')}
        </p>
      </div>

      <UiPanel className="p-4" aria-live="polite" aria-busy={checking || sessionLoading}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dark/60 pb-3">
          <div>
            <div className="text-sm font-medium text-text-dark">{t('settings.dreamina.runtime.title')}</div>
            <div className="mt-0.5 text-xs text-text-muted">{t('settings.dreamina.runtime.subtitle')}</div>
          </div>
          <div className="flex items-center gap-2">
            <UiIconButton
              type="button"
              onClick={() => void runNetworkDiagnose()}
              disabled={diagnosing}
              aria-label={t('settings.dreamina.network.run')}
              title={t('settings.dreamina.network.run')}
            >
              {diagnosing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            </UiIconButton>
            <UiIconButton
              type="button"
              onClick={() => void refreshStatus()}
              disabled={checking}
              aria-label={t('settings.dreamina.runtime.refresh')}
              title={t('settings.dreamina.runtime.refresh')}
            >
              <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            </UiIconButton>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          <StatusMetric
            icon={<Terminal className="h-4 w-4" />}
            label={t('settings.dreamina.runtime.cli')}
            value={checking && !status
              ? t('settings.dreamina.status.checking')
              : status?.installed
                ? (status.version ?? t('settings.dreamina.status.installed'))
                : t('settings.dreamina.status.notInstalled')}
            detail={versionDetail}
            tone={cliTone}
          />
          <StatusMetric
            icon={<KeyRound className="h-4 w-4" />}
            label={t('settings.dreamina.runtime.account')}
            value={accountLabel}
            detail={status?.vipLevel ? t('settings.dreamina.status.vip', { level: status.vipLevel }) : undefined}
            tone={accountTone}
          />
          <StatusMetric
            icon={<WalletCards className="h-4 w-4" />}
            label={t('settings.dreamina.runtime.credits')}
            value={status?.credits === null || status?.credits === undefined
              ? t('settings.dreamina.status.unavailable')
              : status.credits.toLocaleString()}
            tone={status?.credits !== null && status?.credits !== undefined ? 'success' : 'neutral'}
          />
          <StatusMetric
            icon={<FolderCog className="h-4 w-4" />}
            label={t('settings.dreamina.runtime.session')}
            value={t('settings.dreamina.sessions.current', { id: selectedSessionId })}
            detail={status?.sessionsAvailable
              ? t('settings.dreamina.sessions.available')
              : t('settings.dreamina.sessions.degraded')}
            tone={effectiveSessionError ? 'warning' : 'success'}
          />
        </div>

        {status?.resolvedPath && (
          <div className="mt-3 min-w-0 border-t border-border-dark/60 pt-3 text-xs text-text-muted">
            <span className="font-medium text-text-dark">{t('settings.dreamina.runtime.path')}</span>{' '}
            <span className="break-all font-mono">{status.resolvedPath}</span>
          </div>
        )}
        {status?.accountError && (
          <div role="alert" className="mt-3 flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-text-muted">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>{status.accountError}</span>
          </div>
        )}
      </UiPanel>

      {status?.installed && !status.loggedIn && (
        <section className="border-t border-border-dark pt-5" aria-labelledby="dreamina-oauth-title">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="dreamina-oauth-title" className="text-sm font-medium text-text-dark">
                {t('settings.dreamina.oauth.title')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('settings.dreamina.oauth.description')}</p>
            </div>
            {!oauth && (
              <UiButton
                type="button"
                variant="primary"
                className="min-h-11 shrink-0 gap-2"
                onClick={() => void startOAuth()}
                disabled={oauthStarting}
              >
                {oauthStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {oauthStarting ? t('settings.dreamina.oauth.starting') : t('settings.dreamina.oauth.start')}
              </UiButton>
            )}
          </div>

          {oauth && (
            <div className="mt-4 grid gap-4 border-l-2 border-accent/50 pl-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <div className="min-w-0 space-y-3">
                <div>
                  <div className="text-xs font-medium text-text-dark">{t('settings.dreamina.oauth.userCode')}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all border ui-field px-3 py-2 font-mono text-sm font-semibold tracking-normal text-text-dark">
                      {oauth.userCode}
                    </code>
                    <UiIconButton
                      type="button"
                      onClick={() => void copyToClipboard(oauth.userCode ?? '', 'oauth-code')}
                      aria-label={t('settings.dreamina.oauth.copyCode')}
                      title={t('settings.dreamina.oauth.copyCode')}
                    >
                      {copied === 'oauth-code' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </UiIconButton>
                  </div>
                </div>
                <div className="text-xs leading-5 text-text-muted">
                  {t('settings.dreamina.oauth.expires', { seconds: oauth.expiresIn ?? '?' })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <UiButton
                  type="button"
                  className="min-h-11 gap-2"
                  onClick={() => oauth.verificationUri && void openUrl(oauth.verificationUri)}
                  disabled={!oauth.verificationUri}
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('settings.dreamina.oauth.openVerification')}
                </UiButton>
                <UiButton
                  type="button"
                  variant="primary"
                  className="min-h-11 gap-2"
                  onClick={() => void checkOAuth()}
                  disabled={oauthChecking}
                >
                  {oauthChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {oauthChecking ? t('settings.dreamina.oauth.checking') : t('settings.dreamina.oauth.check')}
                </UiButton>
              </div>
            </div>
          )}
          {oauthPending && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-500" role="status">
              <CircleHelp className="h-4 w-4" />
              {t('settings.dreamina.oauth.pending')}
            </div>
          )}
          {oauthError && (
            <div className="mt-3 text-xs leading-5 text-red-500" role="alert">
              {oauthError} {t('settings.dreamina.oauth.retryHint')}
            </div>
          )}
        </section>
      )}

      {status?.installed && (
        <section className="border-t border-border-dark pt-5" aria-labelledby="dreamina-session-title">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="dreamina-session-title" className="text-sm font-medium text-text-dark">
                {t('settings.dreamina.sessions.title')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('settings.dreamina.sessions.description')}</p>
            </div>
            <UiIconButton
              type="button"
              onClick={() => void refreshSessions()}
              disabled={sessionLoading}
              aria-label={t('settings.dreamina.sessions.refresh')}
              title={t('settings.dreamina.sessions.refresh')}
            >
              <RefreshCw className={`h-4 w-4 ${sessionLoading ? 'animate-spin' : ''}`} />
            </UiIconButton>
          </div>
          <div className="mt-3 max-w-xl">
            <label htmlFor="dreamina-default-session" className="mb-1.5 block text-xs font-medium text-text-dark">
              {t('settings.dreamina.sessions.label')}
            </label>
            <UiSelect
              id="dreamina-default-session"
              value={String(selectedSessionId)}
              onChange={(event) => setSelectedSessionId(Number(event.target.value))}
              aria-label={t('settings.dreamina.sessions.label')}
            >
              {!sessionKnown && <option value={String(selectedSessionId)}>{t('settings.dreamina.sessions.missingOption', { id: selectedSessionId })}</option>}
              {sessions.map((session) => (
                <option key={session.id} value={String(session.id)}>
                  {session.isDefault
                    ? t('settings.dreamina.sessions.defaultOption', { name: session.name, id: session.id })
                    : t('settings.dreamina.sessions.option', { name: session.name, id: session.id })}
                </option>
              ))}
            </UiSelect>
            {effectiveSessionError && (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs leading-5 text-amber-500" role="alert">
                <span>{effectiveSessionError}</span>
                {selectedSessionId !== 0 && (
                  <button
                    type="button"
                    className="font-medium text-accent hover:underline"
                    onClick={() => setSelectedSessionId(0)}
                  >
                    {t('settings.dreamina.sessions.useDefault')}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {diagnose && (
        <section className="border-t border-border-dark pt-5" aria-labelledby="dreamina-network-title">
          <h3 id="dreamina-network-title" className="text-sm font-medium text-text-dark">
            {t('settings.dreamina.network.title')}
          </h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {([
              ['DNS', diagnose.dns],
              ['TCP', diagnose.tcp],
              ['TLS', diagnose.tls],
              ['HTTP', diagnose.http],
            ] as const).map(([label, stage]) => (
              <div key={label} className="flex min-w-0 items-start gap-2 border-b border-border-dark/60 py-2">
                {stage.ok
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
                <div className="min-w-0">
                  <div className="text-xs font-medium text-text-dark">{label}</div>
                  <div className="mt-0.5 break-words text-xs leading-5 text-text-muted">{stage.detail || t('settings.dreamina.status.unavailable')}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 whitespace-pre-wrap border-l-2 border-border-dark pl-3 text-xs leading-5 text-text-muted">
            {diagnose.overallAdvice}
          </div>
        </section>
      )}

      {!status?.installed && (
        <details className="border-t border-border-dark pt-5">
          <summary className="cursor-pointer text-sm font-medium text-text-dark">
            {t('settings.dreamina.install.title')}
          </summary>
          <p className="mt-2 text-xs leading-5 text-text-muted">{t('settings.dreamina.install.description')}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto border ui-field px-3 py-2 font-mono text-xs text-text-dark">
              curl -fsSL https://dreamina.jianying.com/install.sh | bash
            </code>
            <UiIconButton
              type="button"
              onClick={() => void copyToClipboard('curl -fsSL https://dreamina.jianying.com/install.sh | bash', 'install')}
              aria-label={t('settings.dreamina.install.copy')}
              title={t('settings.dreamina.install.copy')}
            >
              {copied === 'install' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </UiIconButton>
          </div>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
            onClick={() => void openUrl('https://dreamina.jianying.com/platform/cli')}
          >
            {t('settings.dreamina.install.officialPage')}
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </details>
      )}
    </div>
  );
});

DreaminaSection.displayName = 'DreaminaSection';
