import { useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Bot, CircleAlert, Code2, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import type {
  CanvasAgentRuntimeId,
  ExternalAgentRuntimeDiagnostic,
  ExternalAgentRuntimeId,
} from '../domain/agentModel';

interface Props {
  value: CanvasAgentRuntimeId;
  /** Codex/Claude CLIs exist only in the desktop app; elsewhere only the built-in runtime is offered. */
  externalSupported: boolean;
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
  externalSupported,
  diagnostics,
  isRefreshing,
  disabled = false,
  onChange,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
  const selectedDiagnostic = isExternal(value) ? diagnostics[value] : undefined;
  const selectedUnavailable = selectedDiagnostic && selectedDiagnostic.availability !== 'ready';
  const [guideError, setGuideError] = useState('');

  if (!externalSupported) {
    return (
      <section className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3.5 py-2 text-[11px] text-text-muted" aria-label={t('canvasAgent.runtime.title')}>
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="shrink-0 font-medium text-text-dark">{t('canvasAgent.runtime.builtin')}</span>
        <span className="min-w-0 truncate" title={t('canvasAgent.runtime.requiresDesktop')}>{t('canvasAgent.runtime.requiresDesktop')}</span>
      </section>
    );
  }
  return (
    <section className="shrink-0 border-b border-[var(--line)] px-3 py-2" aria-label={t('canvasAgent.runtime.title')}>
      <div className="flex items-center gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-3 rounded-[6px] border border-[var(--line)] bg-[var(--field-bg)] p-0.5">
          {runtimes.map(({ id, icon: Icon }) => {
            const diagnostic = isExternal(id) ? diagnostics[id] : undefined;
            const ready = id === 'builtin' || diagnostic?.availability === 'ready';
            return (
              <UiButton
                variant="ghost"
                key={id}
                type="button"
                disabled={disabled}
                className={`relative min-h-9 min-w-0 gap-1.5 rounded-[4px] px-2 text-[11px] ${
                  value === id ? 'bg-elevated text-text-dark shadow-xs hover:bg-[var(--hover)]' : ''
                }`}
                aria-pressed={value === id}
                onClick={() => onChange(id)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(`canvasAgent.runtime.${id}`)}</span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    ready ? 'bg-success' : diagnostic ? 'bg-warning' : 'bg-text-muted/40'
                  }`}
                  aria-hidden="true"
                />
              </UiButton>
            );
          })}
        </div>
        <UiIconButton
          size="lg"
          variant="secondary"
          disabled={disabled || isRefreshing}
          title={t('canvasAgent.runtime.refresh')}
          aria-label={t('canvasAgent.runtime.refresh')}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </UiIconButton>
      </div>

      {isExternal(value) && selectedDiagnostic ? (
        <div className={`agent-feed-enter mt-2 flex items-start gap-2 rounded-[5px] border px-2.5 py-2 text-[11px] leading-4 ${
          selectedUnavailable
            ? 'border-warning/25 bg-warning/[0.07] text-warning'
            : 'border-success/20 bg-success/6 text-text-muted'
        }`}>
          {selectedUnavailable ? (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-current">
              {t(`canvasAgent.runtime.status.${selectedDiagnostic.availability}`)}
              {selectedDiagnostic.version ? ` · ${selectedDiagnostic.version}` : ''}
            </div>
            {selectedDiagnostic.detail ? <div className="mt-0.5 wrap-break-word opacity-80">{selectedDiagnostic.detail}</div> : null}
          </div>
          {selectedUnavailable ? (
            <UiIconButton
              className="text-warning hover:bg-warning/10 hover:text-warning"
              title={t('canvasAgent.runtime.installGuide')}
              aria-label={t('canvasAgent.runtime.installGuide')}
              onClick={() => {
                setGuideError('');
                if (isTauri()) void openUrl(installUrls[value]).catch((error: unknown) => setGuideError(error instanceof Error ? error.message : String(error)));
                else window.open(installUrls[value], '_blank', 'noopener,noreferrer');
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </UiIconButton>
          ) : null}
        </div>
      ) : null}
      {guideError && <p role="alert" className="mt-2 break-words text-[11px] text-danger">{guideError}</p>}
    </section>
  );
}
