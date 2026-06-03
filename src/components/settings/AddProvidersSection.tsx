import { memo } from 'react';
import { Image, Layers, Video } from 'lucide-react';

import { CustomProvidersSection } from '@/components/settings/CustomProvidersSection';
import { ModernProvidersSection } from '@/components/settings/ModernProvidersSection';
import { VideoProvidersSection } from '@/components/settings/VideoProvidersSection';

export type AddProviderTab = 'imageNew' | 'imageOld' | 'video';

interface AddProvidersSectionProps {
  activeTab: AddProviderTab;
  onTabChange: (tab: AddProviderTab) => void;
}

const TABS: Array<{
  id: AddProviderTab;
  label: string;
  description: string;
  icon: typeof Image;
}> = [
  {
    id: 'imageNew',
    label: '图片生成（新）',
    description: '主流 Images、Gemini、Fal 等格式优先用这里',
    icon: Image,
  },
  {
    id: 'imageOld',
    label: '图片生成（老）',
    description: '复杂路由、轮询、multipart、签名代理等高级配置',
    icon: Layers,
  },
  {
    id: 'video',
    label: '视频生成',
    description: 'OpenAI Videos API 兼容供应商配置',
    icon: Video,
  },
];

export const AddProvidersSection = memo(function AddProvidersSection({
  activeTab,
  onTabChange,
}: AddProvidersSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">添加供应商</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          按生成类型选择配置入口。图片新/老配置会继续沿用现有功能；视频配置先保存 OpenAI Videos API 兼容参数，供后续视频生成调用层读取。
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent/12'
                  : 'border-border-dark bg-bg-dark hover:border-accent/45'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${selected ? 'text-accent' : 'text-text-muted'}`} />
                <span className="text-sm font-medium text-text-dark">{tab.label}</span>
              </div>
              <div className="mt-1 text-[11px] leading-4 text-text-muted">{tab.description}</div>
            </button>
          );
        })}
      </div>

      {activeTab === 'imageNew' && <ModernProvidersSection />}
      {activeTab === 'imageOld' && <CustomProvidersSection mode="add" />}
      {activeTab === 'video' && <VideoProvidersSection />}
    </div>
  );
});
