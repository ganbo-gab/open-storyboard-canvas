import { useState } from 'react';
import { CloudUpload, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm } from '@/components/ui';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useSettingsStore } from '@/stores/settingsStore';
import { isImageHostConfigured } from '../application/referenceHosting';
import type { ReferenceUrlFailure } from '../domain/referenceErrors';

interface ReferenceUploadActionProps {
  failure: ReferenceUrlFailure;
  /** Sources in the failed slot; 0 when the reference did not come from a declared mode slot. */
  slotSourceCount: number;
  /** Runs only after the user confirmed disclosure to their own image host. */
  onUploadConfirmed: (confirmation: { confirmed: true }) => Promise<void>;
  className?: string;
}

/**
 * The one recovery for "slot needs a public URL": never uploads on its own. Image slots get
 * "upload to my image host and retry" behind a confirmation, or a deep link to configure the host;
 * video/audio slots get the reason, since the image host cannot carry them.
 */
export function ReferenceUploadAction({ failure, slotSourceCount, onUploadConfirmed, className = '' }: ReferenceUploadActionProps) {
  const { t, i18n } = useTranslation();
  const hostSettings = useSettingsStore((state) => state.imageHostSettings);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (failure.slotKind && failure.slotKind !== 'image') {
    return <p className={`text-xs leading-5 text-text-muted ${className}`}>{t('reference.publicUrlRequiredForMedia')}</p>;
  }
  if (failure.slotKind !== 'image' || slotSourceCount === 0) return null;
  const upload = () => {
    setBusy(true);
    setError('');
    onUploadConfirmed({ confirmed: true })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(i18n.exists(message) ? t(message) : message);
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {isImageHostConfigured(hostSettings) ? (
        <UiButton size="sm" variant="primary" loading={busy} icon={<CloudUpload />} onClick={() => setConfirming(true)}>
          {t('reference.uploadAndRetry')}
        </UiButton>
      ) : (
        <UiButton size="sm" icon={<Settings2 />} onClick={() => openSettingsDialog({ category: 'imageHosting' })}>
          {t('reference.configureHost')}
        </UiButton>
      )}
      {error && <p role="alert" className="max-w-full text-xs leading-5 text-danger">{error}</p>}
      <UiConfirm
        isOpen={confirming}
        tone="primary"
        title={t('reference.uploadConfirmTitle')}
        description={t('reference.uploadConfirmDescription', { slotKey: failure.slotKey, count: slotSourceCount })}
        confirmLabel={t('reference.uploadConfirm')}
        onConfirm={upload}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
