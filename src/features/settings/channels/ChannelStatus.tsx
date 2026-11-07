import { useTranslation } from 'react-i18next';
import { UiBadge } from '@/components/ui';
import { channelTestStatus, useChannelUiStore } from '@/features/channels/application/channelUiStore';

/** 未测试 / 已测试 / 测试失败 for one saved channel; the tooltip carries when and how. */
export function ChannelTestBadge({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const record = useChannelUiStore((state) => state.tests[channelId]);
  const status = channelTestStatus(record);
  const title = record
    ? `${t(`ui.channels.status.method.${record.method}`)} · ${new Date(record.at).toLocaleString(i18n.language)}${record.message ? `\n${record.message}` : ''}`
    : t('ui.channels.status.untestedHint');
  return (
    <span title={title} className="inline-flex">
      <UiBadge tone={status === 'passed' ? 'success' : status === 'failed' ? 'danger' : 'neutral'}>
        {t(`ui.channels.status.${status}`)}
      </UiBadge>
    </span>
  );
}

export function ChannelKeyBadge({ ready, required = true }: { ready: boolean; required?: boolean }) {
  const { t } = useTranslation();
  return <UiBadge tone={!required || ready ? 'neutral' : 'warning'}>{t(!required ? 'ui.channels.status.keyNotRequired' : ready ? 'ui.channels.status.keyReady' : 'ui.channels.status.noKey')}</UiBadge>;
}
