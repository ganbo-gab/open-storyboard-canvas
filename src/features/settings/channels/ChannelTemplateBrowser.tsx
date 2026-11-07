import { useState } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiChipButton, UiModal } from '@/components/ui';
import { builtInPresets } from '@/features/channels/presets';
import { channelCapabilities, profileCapabilities, type ChannelCapability } from '@/features/channels/application/channelCapabilities';
import { CapabilityBadges } from '@/features/channels/ui/CapabilityBadge';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { ChannelTemplateConnection } from './ChannelTemplateConnection';
import { ChannelTemplateHelp } from './ChannelTemplateHelp';

export function ChannelTemplateBrowser({ onChoose }: { onChoose(profile: ChannelProfileV2, credential: string): void }) {
  const { t } = useTranslation();
  const [capability, setCapability] = useState<ChannelCapability | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ChannelProfileV2 | null>(null);
  const [help, setHelp] = useState<ChannelProfileV2 | null>(null);
  const profiles = builtInPresets.filter((profile) => (capability === 'all' || profileCapabilities(profile).includes(capability)) && profile.name.toLowerCase().includes(query.toLowerCase()));
  const helpDialog = <UiModal isOpen={help !== null} title={help ? t('ui.channels.templateHelp.title', { name: help.name }) : ''} onClose={() => setHelp(null)} widthClassName="w-[760px]">
    {help && <ChannelTemplateHelp profile={help} />}
  </UiModal>;
  if (selected) return <div className="space-y-4"><div className="flex items-center justify-between gap-3"><UiButton variant="ghost" icon={<ArrowLeft />} onClick={() => setSelected(null)}>更换接口协议</UiButton><UiButton variant="ghost" icon={<CircleHelp />} onClick={() => setHelp(selected)}>{t('ui.channels.templateHelp.open')}</UiButton></div><ChannelTemplateConnection key={selected.id} template={selected} onChoose={onChoose} />{helpDialog}</div>;
  return <div className="space-y-5">
    <div><h3 className="text-base font-semibold">选择接口协议</h3><p className="mt-2 text-sm leading-6 text-text-muted">模板只提供请求格式。下一步填写你的地址和密钥，再读取或手动添加模型；不会接入模板里的示例模型。</p></div>
    <div className="flex flex-wrap gap-2"><UiChipButton active={capability === 'all'} onClick={() => setCapability('all')}>全部协议</UiChipButton>{channelCapabilities.map((kind) => <UiChipButton key={kind} active={kind === capability} onClick={() => setCapability(kind)}>{t(`ui.channels.cap.${kind}.long`)}</UiChipButton>)}</div>
    <label className="ui-input flex items-center gap-2 px-3"><Search size={16} /><input aria-label="搜索接口协议" placeholder="搜索接口协议" className="min-w-0 flex-1 bg-transparent py-2 outline-none" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{profiles.map((profile) => <article key={profile.id} className="channel-template-card">
      <div className="flex w-full items-center justify-between gap-2"><h4 className="text-sm font-semibold">{profile.name}</h4><button type="button" aria-label={t('ui.channels.templateHelp.openFor', { name: profile.name })} title={t('ui.channels.templateHelp.open')} className="rounded-md p-2 hover:bg-(--hover) focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setHelp(profile)}><CircleHelp size={16} /></button></div>
      <CapabilityBadges capabilities={profileCapabilities(profile)} />
      <UiButton variant="ghost" className="mt-auto w-full justify-between" onClick={() => setSelected(profile)}>填写连接信息 <ArrowRight size={15} /></UiButton>
    </article>)}</div>
    {!profiles.length && <p className="text-sm text-text-muted">没有匹配的协议，可返回使用接口文档接入。</p>}
    {helpDialog}
  </div>;
}
