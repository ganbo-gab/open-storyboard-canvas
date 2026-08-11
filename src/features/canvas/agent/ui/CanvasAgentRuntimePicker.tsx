import { Bot, CircleAlert, Code2, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import type {
  CanvasAgentRuntimeId,
  ExternalAgentRuntimeDiagnostic,
  ExternalAgentRuntimeId,
} from '../domain/agentModel';

interface Props {
  value: CanvasAgentRuntimeId;
  diagnostics: Partial<Record<ExternalAgentRuntimeId, ExternalAgentRuntimeDiagnostic>>;
  isRefreshing: boolean;
  disabled?: boolean;
  onChange: (runtime: CanvasAgentRuntimeId) => void;
  onRefresh: () => void;
}

const runtimes: Array<{
  id: CanvasAgentRuntimeId;
  icon: typeof Bot;
}> = [
  { id: 'builtin', icon: Sparkles },
  { id: 'codex', icon: Code2 },
  { id: 'claude', icon: Bot },
];

const installUrls: Record<ExternalAgentRuntimeId, string> = {
  codex: 'https://developers.openai.com/codex/cli/',
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
};

function isExternal(runtime: CanvasAgentRuntimeId): runtime is ExternalAgentRuntimeId {
  return runtime !== 'builtin';
}

export function CanvasAgentRuntimePicker({
  value,
  diagnostics,
  isRefreshing,
  disabled = false,
  onChange,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
  const selectedDiagnostic = isExternal(value) ? diagnostics[value] : undefined;
  const selectedUnavailable = selectedDiagnostic && selectedDiagnostic.availability !== 'ready';

  return (
    <section className="shrink-0 border-b border-border-dark/70 px-3 py-2" aria-label={t('canvasAgent.runtime.title')}>
      <div className="flex items-center gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-3 rounded-[6px] border border-border-dark bg-text-dark/[0.025] p-0.5">
          {runtimes.map(({ id, icon: Icon }) => {
            const diagnostic = isExternal(id) ? diagnostics[id] : undefined;
            const ready = id === 'builtin' || diagnostic?.availability === 'ready';
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                className={`relative inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-[4px] px-2 text-[11px] transition-[background-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                  value === id
                    ? 'bg-bg-dark text-text-dark shadow-sm'
                    : 'text-text-muted hover:bg-text-dark/[0.04] hover:text-text-dark'
                }`}
                aria-pressed={value === id}
                onClick={() => onChange(id)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(`canvasAgent.runtime.${id}`)}</span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    ready ? 'bg-emerald-500' : diagnostic ? 'bg-amber-400' : 'bg-text-muted/40'
                  }`}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled || isRefreshing}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[5px] border border-border-dark text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title={t('canvasAgent.runtime.refresh')}
          aria-label={t('canvasAgent.runtime.refresh')}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {isExternal(value) && selectedDiagnostic ? (
        <div className={`agent-feed-enter mt-2 flex items-start gap-2 rounded-[5px] border px-2.5 py-2 text-[11px] leading-4 ${
          selectedUnavailable
            ? 'border-amber-500/25 bg-amber-500/[0.07] text-amber-800 dark:text-amber-100'
            : 'border-emerald-500/20 bg-emerald-500/[0.06] text-text-muted'
        }`}>
          {selectedUnavailable ? (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-current">
              {t(`canvasAgent.runtime.status.${selectedDiagnostic.availability}`)}
              {selectedDiagnostic.version ? ` · ${selectedDiagnostic.version}` : ''}
            </div>
            {selectedDiagnostic.detail ? <div className="mt-0.5 break-words opacity-80">{selectedDiagnostic.detail}</div> : null}
          </div>
          {selectedUnavailable ? (
            <button
              type="button"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] transition-[background-color,transform] duration-150 hover:bg-current/[0.08] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
              title={t('canvasAgent.runtime.installGuide')}
              aria-label={t('canvasAgent.runtime.installGuide')}
              onClick={() => { void openUrl(installUrls[value]); }}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
