import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';

import { verifyAgnesKey } from '@/features/canvas/infrastructure/customProviderGateway';
import { useSettingsStore } from '@/stores/settingsStore';

const AGNES_DOCS = [
  {
    title: 'Agnes 2.5 Flash',
    url: 'https://wiki.agnes-ai.com/en/docs/agnes-25-flash',
    noteKey: 'settings.agnes.docs.chat25',
  },
  {
    title: 'Agnes 1.5 Flash',
    url: 'https://wiki.agnes-ai.com/en/docs/agnes-15-flash',
    noteKey: 'settings.agnes.docs.chatLegacy',
  },
  {
    title: 'Agnes Image 2.1 Flash',
    url: 'https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash',
    noteKey: 'settings.agnes.docs.image21',
  },
  {
    title: 'Agnes Image 2.0 Flash',
    url: 'https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash',
    noteKey: 'settings.agnes.docs.image20',
  },
  {
    title: 'Agnes Video v2.0',
    url: 'https://wiki.agnes-ai.com/en/docs/agnes-video-v20',
    noteKey: 'settings.agnes.docs.video20',
  },
];

export const AgnesSettingsSection = memo(function AgnesSettingsSection() {
  const { t } = useTranslation();
  const agnesApiKey = useSettingsStore((state) => state.agnesApiKey);
  const setAgnesApiKey = useSettingsStore((state) => state.setAgnesApiKey);
  const [localKey, setLocalKey] = useState(agnesApiKey);
  const [savedFlash, setSavedFlash] = useState(false);
  const [verification, setVerification] = useState<
    { state: 'unverified' | 'verifying' | 'verified' | 'failed'; message?: string }
  >({ state: 'unverified' });
  const verificationRequestRef = useRef(0);

  const invalidateVerification = useCallback(() => {
    verificationRequestRef.current += 1;
    setVerification({ state: 'unverified' });
  }, []);

  useEffect(() => {
    setLocalKey(agnesApiKey);
    invalidateVerification();
  }, [agnesApiKey, invalidateVerification]);

  useEffect(() => () => {
    verificationRequestRef.current += 1;
  }, []);

  const handleSave = useCallback(() => {
    setAgnesApiKey(localKey.trim());
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  }, [localKey, setAgnesApiKey]);

  const handleVerify = useCallback(async () => {
    const requestId = verificationRequestRef.current + 1;
    verificationRequestRef.current = requestId;
    const keyToVerify = localKey;
    setVerification({ state: 'verifying' });
    const result = await verifyAgnesKey(keyToVerify);
    if (verificationRequestRef.current !== requestId) return;
    if (result.ok) {
      setVerification({
        state: 'verified',
        message: t('settings.agnes.verifySuccess', { count: result.modelCount ?? 0 }),
      });
    } else {
      const categoryKey = result.category
        ? `settings.agnes.verifyErrors.${result.category}`
        : 'settings.agnes.verifyFailed';
      setVerification({ state: 'failed', message: t(categoryKey) });
    }
  }, [localKey, t]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">Agnes</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t('settings.agnes.description')}
        </p>
      </div>

      <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-text-muted">{t('settings.agnes.keyLabel')}</span>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-0 flex-1">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={localKey}
                onChange={(event) => {
                  setLocalKey(event.target.value);
                  invalidateVerification();
                }}
                className="h-9 w-full rounded-md border border-border-dark bg-surface-dark pl-9 pr-3 text-sm text-text-dark outline-none focus:border-accent"
                placeholder={t('settings.agnes.keyPlaceholder')}
                type="password"
              />
            </div>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90"
            >
              <CheckCircle2 className="h-4 w-4" />
              {t('settings.agnes.save')}
            </button>
            <button
              type="button"
              onClick={() => { void handleVerify(); }}
              disabled={!localKey.trim() || verification.state === 'verifying'}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-dark px-3 text-sm font-medium text-text-dark hover:border-accent/45 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verification.state === 'verifying'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ShieldCheck className="h-4 w-4" />}
              {verification.state === 'verifying' ? t('settings.agnes.verifying') : t('settings.agnes.verify')}
            </button>
          </div>
        </label>
        {savedFlash && (
          <div className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> {t('settings.agnes.saved')}
          </div>
        )}
        {verification.state === 'verifying' && (
          <div aria-live="polite" className="mt-2 text-xs text-text-muted">
            {t('settings.agnes.verifying')}
          </div>
        )}
        {verification.state !== 'unverified' && verification.state !== 'verifying' && (
          <div
            role="status"
            aria-live="polite"
            className={`mt-2 inline-flex items-start gap-1 text-xs ${verification.state === 'verified' ? 'text-emerald-300' : 'text-amber-300'}`}
          >
            {verification.state === 'verified'
              ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {verification.message}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {AGNES_DOCS.map((doc) => (
          <button
            key={doc.url}
            type="button"
            onClick={() => { void openUrl(doc.url); }}
            className="rounded-lg border border-border-dark bg-bg-dark p-3 text-left transition-colors hover:border-accent/45"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-text-dark">{doc.title}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            </div>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{t(doc.noteKey)}</p>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-3 text-[11px] leading-5 text-text-muted">
        {t('settings.agnes.chatNote')}
      </div>
    </div>
  );
});
