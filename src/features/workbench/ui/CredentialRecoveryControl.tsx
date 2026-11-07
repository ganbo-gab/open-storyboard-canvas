import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { UiButton } from '@/components/ui';
import { authorizeChannelJob } from '@/features/channels/runtime/channelExecution';

export function CredentialRecoveryControl({ jobId, canQuery, onAuthorized }: { jobId: string; canQuery: boolean; onAuthorized(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="mt-2">
    <UiButton size="sm" variant="secondary" icon={<KeyRound />} disabled={busy} loading={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError('');
      try { await authorizeChannelJob(jobId); if (canQuery) await onAuthorized(); else setError('凭据已授权。此前请求尚未发出，可重新点击生成。'); }
      catch { setError('授权未完成，已停止查询。请在系统弹窗中授权，或到渠道设置检查凭据。'); }
      finally { setBusy(false); }
    }}>{canQuery ? '重新授权并查询原结果' : '重新授权系统凭据'}</UiButton>
    {error && <p role="status" className="mt-1 text-xs text-text-muted">{error}</p>}
  </div>;
}
