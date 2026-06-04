import { memo, useEffect, useMemo, useState } from 'react';
import { Film, ImageIcon, Search, X } from 'lucide-react';

export type CanvasAssetKind = 'image' | 'video';

interface CanvasAssetItemBase {
  id: string;
  nodeId: string;
  kind: CanvasAssetKind;
  aspectRatio?: string;
  title: string;
  sourceLabel: string;
  order: number;
}

export interface CanvasImageAssetItem extends CanvasAssetItemBase {
  kind: 'image';
  rawImageUrl: string;
  rawPreviewImageUrl?: string | null;
  imageUrl: string;
  previewImageUrl: string;
}

export interface CanvasVideoAssetItem extends CanvasAssetItemBase {
  kind: 'video';
  rawVideoUrl: string;
  rawThumbnailUrl?: string | null;
  videoUrl: string;
  thumbnailUrl?: string | null;
}

export type CanvasAssetItem = CanvasImageAssetItem | CanvasVideoAssetItem;

interface AssetPanelProps {
  isOpen: boolean;
  assets: CanvasAssetItem[];
  buttonRect: DOMRect | null;
  mode?: 'browse' | 'select';
  title?: string;
  subtitle?: string;
  onClose: () => void;
  onActivate: (asset: CanvasAssetItem) => void;
  onRename?: (asset: CanvasAssetItem, title: string) => void;
}

function groupAssets(assets: CanvasAssetItem[]) {
  const sorted = assets.slice().sort((a, b) => b.order - a.order);
  if (sorted.length <= 8) {
    return [{ label: '当前项目资产', items: sorted }];
  }
  return [
    { label: '最新资产', items: sorted.slice(0, 8) },
    { label: '较早资产', items: sorted.slice(8) },
  ].filter((group) => group.items.length > 0);
}

export const AssetPanel = memo(({
  isOpen,
  assets,
  buttonRect,
  mode = 'browse',
  title = '资产',
  subtitle = '当前项目 · 双击资产定位到画布节点',
  onClose,
  onActivate,
  onRename,
}: AssetPanelProps) => {
  const [query, setQuery] = useState('');
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [activeKind, setActiveKind] = useState<CanvasAssetKind>('image');
  const imageCount = useMemo(() => assets.filter((asset) => asset.kind === 'image').length, [assets]);
  const videoCount = useMemo(() => assets.filter((asset) => asset.kind === 'video').length, [assets]);

  useEffect(() => {
    if (!isOpen) return;
    if (activeKind === 'image' && imageCount === 0 && videoCount > 0) {
      setActiveKind('video');
    }
    if (activeKind === 'video' && videoCount === 0 && imageCount > 0) {
      setActiveKind('image');
    }
  }, [activeKind, imageCount, isOpen, videoCount]);

  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const kindAssets = assets.filter((asset) => asset.kind === activeKind);
    if (!normalized) return kindAssets;
    return kindAssets.filter((asset) => {
      const haystack = `${asset.title} ${asset.sourceLabel}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeKind, assets, query]);
  const groups = useMemo(() => groupAssets(filteredAssets), [filteredAssets]);
  const activeKindLabel = activeKind === 'image' ? '图片' : '视频';

  useEffect(() => {
    if (!isOpen) return;
    setNameDrafts((previous) => {
      const next: Record<string, string> = {};
      for (const asset of assets) {
        next[asset.id] = Object.prototype.hasOwnProperty.call(previous, asset.id)
          ? previous[asset.id]
          : asset.title;
      }
      return next;
    });
  }, [assets, isOpen]);

  const commitAssetName = (asset: CanvasAssetItem) => {
    const draft = (nameDrafts[asset.id] ?? asset.title).trim();
    if (!draft) {
      setNameDrafts((previous) => ({ ...previous, [asset.id]: asset.title }));
      return;
    }
    if (draft !== asset.title) {
      onRename?.(asset, draft);
    }
    setNameDrafts((previous) => ({ ...previous, [asset.id]: draft }));
  };

  if (!isOpen || !buttonRect) {
    return null;
  }

  const panelWidth = 360;
  const panelLeft = Math.min(
    Math.max(8, buttonRect.right + 8),
    Math.max(8, window.innerWidth - panelWidth - 8)
  );
  const panelTop = Math.min(
    Math.max(8, buttonRect.top - 120),
    Math.max(8, window.innerHeight - 560)
  );

  return (
    <div
      className="fixed z-[220] flex max-h-[540px] flex-col rounded-xl border border-white/12 bg-[#202020] shadow-2xl"
      style={{ left: panelLeft, top: panelTop, width: panelWidth }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 text-[11px] text-white/45">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"
          title="关闭资产面板"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-1 border-b border-white/8 px-3 py-2">
        <button
          type="button"
          onClick={() => setActiveKind('image')}
          className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors ${
            activeKind === 'image'
              ? 'bg-accent/85 text-white'
              : 'bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white/85'
          }`}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          图片
          <span className="text-[10px] opacity-70">{imageCount}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveKind('video')}
          className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors ${
            activeKind === 'video'
              ? 'bg-accent/85 text-white'
              : 'bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white/85'
          }`}
        >
          <Film className="h-3.5 w-3.5" />
          视频
          <span className="text-[10px] opacity-70">{videoCount}</span>
        </button>
      </div>

      <div className="border-b border-white/8 px-3 py-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 text-white/70 focus-within:border-accent/50">
          <Search className="h-3.5 w-3.5 shrink-0 text-white/35" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${activeKindLabel}名称`}
            className="min-w-0 flex-1 bg-transparent text-xs text-white/85 outline-none placeholder:text-white/30"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="rounded p-0.5 text-white/35 hover:bg-white/10 hover:text-white/75"
              title="清空搜索"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
      </div>

      <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
        {assets.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-white/12 bg-white/[0.03] px-6 text-center">
            <ImageIcon className="mb-3 h-8 w-8 text-white/25" />
            <div className="text-sm text-white/70">这个项目还没有资产</div>
            <div className="mt-1 text-[11px] leading-5 text-white/40">
              上传或生成图片、视频、故事板或全景图后，会自动出现在这里。
            </div>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-white/12 bg-white/[0.03] px-6 text-center">
            {query ? (
              <Search className="mb-3 h-7 w-7 text-white/25" />
            ) : activeKind === 'image' ? (
              <ImageIcon className="mb-3 h-7 w-7 text-white/25" />
            ) : (
              <Film className="mb-3 h-7 w-7 text-white/25" />
            )}
            <div className="text-sm text-white/70">
              {query ? `没有匹配的${activeKindLabel}` : `这个项目还没有${activeKindLabel}资产`}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-white/40">
              {query ? '换个名称试试，或清空搜索查看全部资产。' : `切换到其他类型，或先在画布中创建${activeKindLabel}节点。`}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.label}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-medium text-white/70">{group.label}</h3>
                  <span className="text-[10px] text-white/35">
                    {group.items.length} {activeKind === 'image' ? '张' : '个'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((asset) => (
                    <div
                      key={asset.id}
                      title={mode === 'select' ? `${asset.title} · 选择并连接` : `${asset.title} · 双击定位`}
                      className="group overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] text-left transition-colors hover:border-accent/70 hover:bg-accent/10"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (mode === 'select') {
                            onActivate(asset);
                          }
                        }}
                        onDoubleClick={() => {
                          if (mode === 'browse') {
                            onActivate(asset);
                          }
                        }}
                        className="block aspect-square w-full overflow-hidden bg-black/30"
                        title={mode === 'select' ? `${asset.title} · 选择并连接` : `${asset.title} · 双击定位`}
                      >
                        {asset.kind === 'image' ? (
                          <img
                            src={asset.previewImageUrl}
                            alt={asset.title}
                            className="h-full w-full object-cover transition-transform group-hover:scale-105"
                            draggable={false}
                          />
                        ) : (
                          <div className="relative h-full w-full bg-black">
                            <video
                              src={asset.videoUrl}
                              poster={asset.thumbnailUrl ?? undefined}
                              className="h-full w-full object-cover opacity-90 transition-transform group-hover:scale-105"
                              muted
                              playsInline
                              preload="metadata"
                            />
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
                              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white">
                                <Film className="h-4 w-4" />
                              </span>
                            </div>
                          </div>
                        )}
                      </button>
                      <div className="space-y-0.5 px-2 py-1.5">
                        {mode === 'browse' ? (
                          <input
                            value={nameDrafts[asset.id] ?? asset.title}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setNameDrafts((previous) => ({ ...previous, [asset.id]: nextValue }));
                            }}
                            onBlur={() => commitAssetName(asset)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                setNameDrafts((previous) => ({ ...previous, [asset.id]: asset.title }));
                                event.currentTarget.blur();
                              }
                            }}
                            className="nodrag w-full rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[10px] font-medium text-white/80 outline-none transition-colors hover:border-white/20 hover:bg-black/35 focus:border-accent/60 focus:bg-black/40"
                            title="双击资产定位；这里可直接改名，允许同名"
                          />
                        ) : (
                          <div className="truncate rounded border border-transparent px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                            {asset.title}
                          </div>
                        )}
                        <div className="truncate text-[9px] text-white/35">{asset.sourceLabel}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

AssetPanel.displayName = 'AssetPanel';
