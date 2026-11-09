import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { UiButton } from '@/components/ui';
import { authorizeChannelJob } from '@/features/channels/runtime/channelExecution';
import { credentialFailureMessage, credentialFailureOf } from '@/features/secrets/credentialFailure';

export function CredentialRecoveryControl({ jobId, canQuery, onAuthorized }: { jobId: string; canQuery: boolean; onAuthorized(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="mt-2">
    <UiButton size="sm" variant="secondary" icon={<KeyRound />} disabled={busy} loading={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError('');
      let readable = false;
      try {
        await authorizeChannelJob(jobId); readable = true;
        if (canQuery) await onAuthorized(); else setError('凭据已可用。此前请求尚未发出，可重新点击生成。');
      } catch (cause) {
        setError(readable && !credentialFailureOf(cause)
          ? '凭据已可用，但原结果查询未完成。请查看任务详情后重试查询。'
          : `已停止查询。${credentialFailureMessage(cause)}`);
      }
      finally { setBusy(false); }
    }}>{canQuery ? '重试读取凭据并查询原结果' : '重试读取凭据'}</UiButton>
    {error && <p role="status" className="mt-1 text-xs text-text-muted">{error}</p>}
  </div>;
}
