import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiTabs } from '@/components/ui';
import type { ModelSpec } from '../domain/profile';
import { channelCapabilities, modelCapabilities, modelCapabilityCounts, modelsWithCapability, type ChannelCapability } from '../application/channelCapabilities';
import { CAPABILITY_ICON, CAPABILITY_TEXT } from './capabilityStyles';
import { ModelSpecCard } from './ModelSpecCard';

/** 「大语言模型 1 · 图片 1 · 视频 1」 tabs that switch the model list of one template or channel. */
export function CapabilityModelTabs({ models, initial }: { models: readonly ModelSpec[]; initial?: ChannelCapability }) {
  const { t } = useTranslation();
  const panelId = useId();
  const counts = modelCapabilityCounts(models);
  const available = channelCapabilities.filter((capability) => counts[capability] > 0);
  const [picked, setPicked] = useState<ChannelCapability | undefined>(initial);
  const active = picked && available.includes(picked) ? picked : available[0];
  if (!active) return <p className="text-[13px] text-text-muted">{t('ui.channels.detail.noModels')}</p>;
  const list = modelsWithCapability(models, active);
  return (
    <div>
      <UiTabs
        aria-label={t('ui.channels.detail.capabilityTabs')}
        className="ui-scrollbar overflow-x-auto"
        value={active}
        onChange={setPicked}
        options={available.map((capability) => {
          const Icon = CAPABILITY_ICON[capability];
          return {
            value: capability,
            icon: <Icon className={CAPABILITY_TEXT[capability]} aria-hidden />,
            label: <span className="whitespace-nowrap">{t(`ui.channels.cap.${capability}.long`)}<span className="ml-1.5 tabular-nums text-text-subtle">{counts[capability]}</span></span>,
          };
        })}
      />
      <div role="tabpanel" id={panelId} aria-label={t(`ui.channels.cap.${active}.long`)} className="mt-4 grid gap-3 lg:grid-cols-2">
        {list.map((model) => <ModelSpecCard key={model.id} model={model} showCapabilities={modelCapabilities(model).length > 1} />)}
      </div>
    </div>
  );
}
