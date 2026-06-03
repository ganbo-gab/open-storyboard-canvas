import { memo, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

import { useSettingsStore } from '@/stores/settingsStore';

const AGNES_DOCS = [
  {
    title: 'Agnes Image 2.1 Flash',
    url: 'https://agnes-ai.com/doc/agnes-image-21-flash',
    note: '图片生成模型说明。后续图片调用层可读取这里保存的 Agnes Key。',
  },
  {
    title: 'Agnes Image 2.0 Flash',
    url: 'https://agnes-ai.com/doc/agnes-image-20-flash',
    note: '图片生成兼容说明。当前先提供 key 管理和文档入口。',
  },
  {
    title: 'Agnes Video v2.0',
    url: 'https://agnes-ai.com/doc/agnes-video-v20',
    note: '视频生成模型说明。后续视频调用层可接入该 key。',
  },
];

export const AgnesSettingsSection = memo(function AgnesSettingsSection() {
  const agnesApiKey = useSettingsStore((state) => state.agnesApiKey);
  const setAgnesApiKey = useSettingsStore((state) => state.setAgnesApiKey);
  const [localKey, setLocalKey] = useState(agnesApiKey);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setLocalKey(agnesApiKey);
  }, [agnesApiKey]);

  const handleSave = useCallback(() => {
    setAgnesApiKey(localKey);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  }, [localKey, setAgnesApiKey]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">Agnes</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          独立管理 Agnes Key，并保留图片 / 视频模型说明入口。当前不会自动改动现有图片供应商配置。
        </p>
      </div>

      <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-text-muted">Agnes Key</span>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={localKey}
                onChange={(event) => setLocalKey(event.target.value)}
                className="h-9 w-full rounded-md border border-border-dark bg-surface-dark pl-9 pr-3 text-sm text-text-dark outline-none focus:border-accent"
                placeholder="输入 Agnes API Key"
                type="password"
              />
            </div>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90"
            >
              <CheckCircle2 className="h-4 w-4" />
              保存
            </button>
          </div>
        </label>
        {savedFlash && (
          <div className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> 已保存 Agnes Key
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
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
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{doc.note}</p>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-3 text-[11px] leading-5 text-text-muted">
        Agnes 文档页面当前由前端渲染，静态正文不稳定；这里先保存独立 key 与模型说明入口，后续后端 / 前端调用层可通过 `settingsStore.agnesApiKey` 读取。
      </div>
    </div>
  );
});
