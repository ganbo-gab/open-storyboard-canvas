import { memo, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

import { useSettingsStore } from '@/stores/settingsStore';

const AGNES_DOCS = [
  {
    title: 'Agnes 2.0 Flash',
    url: 'https://agnes-ai.com/doc/agnes-20-flash',
    note: '多模态文本模型。官方支持 stream / tools / thinking；当前应用默认使用非流式 JSON 兼容模式。',
  },
  {
    title: 'Agnes 1.5 Flash',
    url: 'https://agnes-ai.com/doc/agnes-15-flash',
    note: '多模态文本模型。保存的 Agnes Key 会用于 AI 文本节点的非流式对话请求。',
  },
  {
    title: 'Agnes Image 2.1 Flash',
    url: 'https://agnes-ai.com/doc/agnes-image-21-flash',
    note: '图片生成模型。保存的 Agnes Key 会用于 AI 图片节点，默认优先请求 base64 结果。',
  },
  {
    title: 'Agnes Image 2.0 Flash',
    url: 'https://agnes-ai.com/doc/agnes-image-20-flash',
    note: '图片生成 / 多参考图模型。参考图会按官方 image 数组发送。',
  },
  {
    title: 'Agnes Video v2.0',
    url: 'https://agnes-ai.com/doc/agnes-video-v20',
    note: '视频生成模型。保存的 Agnes Key 会用于 AI 视频节点，支持文生、图生、多参考和关键帧模式。',
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
          独立管理 Agnes Key。保存后会用于 Agnes AI 图片、AI 视频和 AI 文本模型；不会自动改动你在「我的配置」里保存的其他供应商。
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
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
        Agnes Chat 2.0 官方支持流式、工具调用和 thinking 参数；当前网关以非流式 JSON 响应为默认兼容策略，避免 SSE 响应被普通 JSON 解析器误读。
      </div>
    </div>
  );
});
