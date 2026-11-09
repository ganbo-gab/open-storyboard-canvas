import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiConfirm } from '@/components/ui/UiConfirm';
import { UiIconButton, UiInput } from '@/components/ui';
import { secretRefFromToken, secretStore, useCredentialState, retrySecretAccess } from './secretStore';
import { credentialFailureMessage } from './credentialFailure';

interface SecretFieldProps {
  /** A transient new value or a saved vault reference token. Tokens are never put in the DOM input. */
  value: string;
  onChange(value: string): void;
  id?: string;
  label?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoComplete?: string;
}

/** Vault-aware edit field. Revealing a stored value is explicit and never changes the saved draft. */
export function SecretField({ value, onChange, id, label, placeholder, className = '', disabled, autoComplete = 'off' }: SecretFieldProps) {
  const { t } = useTranslation();
  const reference = secretRefFromToken(value);
  const state = useCredentialState(reference);
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; value: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const token = reference ? value : null;
  const requestVersion = useRef(0);
  useEffect(() => {
    requestVersion.current += 1;
    setVisible(false); setRevealed(null); setError(''); setReading(false);
    const stored = token ? secretRefFromToken(token) : null;
    // `has` updates the public state without retrieving the credential value.
    if (stored) void secretStore.has(stored).catch(() => undefined);
    return () => { requestVersion.current += 1; };
  }, [token]);
  const toggleVisibility = async () => {
    if (visible) { setVisible(false); setRevealed(null); return; }
    if (!reference) { setVisible(true); return; }
    const version = ++requestVersion.current;
    setReading(true); setError('');
    try {
      const secret = await secretStore.reveal(reference);
      if (version !== requestVersion.current) return;
      if (secret === null) { setError(t('secrets.state.missing')); return; }
      setRevealed({ token: value, value: secret }); setVisible(true);
    } catch (cause) {
      if (version === requestVersion.current) setError(credentialFailureMessage(cause));
    } finally {
      if (version === requestVersion.current) setReading(false);
    }
  };
  return (
    <div className={`min-w-0 space-y-1.5 ${className}`}>
      <div className="flex min-w-0 items-center gap-1">
        <UiInput
          id={id}
          aria-label={label}
          type={visible && (!reference || revealed?.token === value) ? 'text' : 'password'}
          autoComplete={autoComplete}
          disabled={disabled || reading}
          value={reference ? revealed?.token === value ? revealed.value : '' : value}
          placeholder={reference ? t(`secrets.state.${state}`) : placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 font-mono"
          spellCheck={false}
        />
        <UiIconButton disabled={disabled || reading || (!reference && !value)} aria-label={t(visible ? 'secrets.hide' : 'secrets.reveal')} aria-pressed={visible} onClick={() => void toggleVisibility()}>
          {visible ? <EyeOff /> : <Eye />}
        </UiIconButton>
        <UiIconButton disabled={disabled || reading || !value} aria-label={t('secrets.delete')} onClick={() => setDeleting(true)}><Trash2 /></UiIconButton>
      </div>
      {reference && <p className={`text-[11px] leading-5 ${state === 'present' ? 'text-text-muted' : 'text-warning'}`}>{t(`secrets.state.${state}`)}</p>}
      {reference && state !== 'present' && <button type="button" className="text-xs text-accent" disabled={disabled || reading} onClick={async () => {
        setReading(true); setError('');
        try { if (!await retrySecretAccess(reference)) setError(t('secrets.state.missing')); }
        catch (cause) { setError(credentialFailureMessage(cause)); }
        finally { setReading(false); }
      }}>重试读取凭据</button>}
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      <UiConfirm isOpen={deleting} title={t('secrets.delete')} description={t('secrets.deleteDraftNotice')} onConfirm={() => { onChange(''); setRevealed(null); setVisible(false); }} onClose={() => setDeleting(false)} containerClassName="z-[10010]" />
    </div>
  );
}
