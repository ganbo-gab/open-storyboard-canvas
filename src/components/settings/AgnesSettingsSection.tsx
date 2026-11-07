import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';

import { UiButton, UiField } from '@/components/ui';
import { SecretField } from '@/features/secrets/SecretField';
import { verifyAgnesKey } from '@/features/channels/runtime/agnesChannel';
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [verification, setVerification] = useState<
    { state: 'unverified' | 'verifying' | 'verified' | 'failed'; message?: string }
  >({ state: 'unverified' });
  const verificationRequestRef = useRef(0);
  const keyInputId = useId();

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

  const handleSave = useCallback(async () => {
    setSaving(true); setSaveError('');
    try {
      await setAgnesApiKey(localKey.trim());
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
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
    <>
      <div className="border-b border-[var(--line)] px-6 py-5">
        <h2 className="text-[15px] font-semibold text-text-dark">Agnes</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          {t('settings.agnes.description')}
        </p>
      </div>

      <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
        <section className="rounded-xl border border-[var(--line)] bg-surface p-4">
          <UiField label={t('settings.agnes.keyLabel')} htmlFor={keyInputId}>
            <div className="flex flex-wrap gap-2">
              <SecretField
                id={keyInputId}
                label={t('settings.agnes.keyLabel')}
                value={localKey}
                onChange={(next) => {
                  setLocalKey(next);
                  invalidateVerification();
                }}
                placeholder={t('settings.agnes.keyPlaceholder')}
                className="flex-1 basis-56"
              />
              <UiButton variant="primary" icon={<CheckCircle2 />} loading={saving} onClick={() => { void handleSave(); }}>
                {t('settings.agnes.save')}
              </UiButton>
              <UiButton
                variant="secondary"
                icon={<ShieldCheck />}
                loading={verification.state === 'verifying'}
                onClick={() => { void handleVerify(); }}
                disabled={!localKey.trim()}
              >
                {verification.state === 'verifying' ? t('settings.agnes.verifying') : t('settings.agnes.verify')}
              </UiButton>
            </div>
          </UiField>
          {saveError && (
            <div role="alert" className="mt-2 inline-flex items-start gap-1 text-[12px] text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {saveError}
            </div>
          )}
          {savedFlash && (
            <div className="mt-2 inline-flex items-center gap-1 text-[12px] text-success">
              <CheckCircle2 className="h-3.5 w-3.5" /> {t('settings.agnes.saved')}
            </div>
          )}
          {verification.state === 'verifying' && (
            <div aria-live="polite" className="mt-2 text-[12px] text-text-muted">
              {t('settings.agnes.verifying')}
            </div>
          )}
          {verification.state !== 'unverified' && verification.state !== 'verifying' && (
            <div
              role="status"
              aria-live="polite"
              className={`mt-2 inline-flex items-start gap-1 text-[12px] ${verification.state === 'verified' ? 'text-success' : 'text-warning'}`}
            >
              {verification.state === 'verified'
                ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {verification.message}
            </div>
          )}
        </section>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AGNES_DOCS.map((doc) => (
            <UiButton
              key={doc.url}
              variant="secondary"
              onClick={() => { void openUrl(doc.url); }}
              className="h-auto w-full flex-col items-stretch justify-start gap-2 rounded-xl p-3 text-left whitespace-normal"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-text-dark">{doc.title}</span>
                <ExternalLink className="text-text-muted" />
              </span>
              <span className="text-[12px] font-normal leading-5 text-text-muted">{t(doc.noteKey)}</span>
            </UiButton>
          ))}
        </div>

        <div className="rounded-xl border border-dashed border-[var(--line)] p-3 text-[12px] leading-5 text-text-muted">
          {t('settings.agnes.chatNote')}
        </div>
      </div>
    </>
  );
});
