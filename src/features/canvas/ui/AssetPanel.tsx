import { UiButton, UiIconButton, UiInput, UiSegmented } from '@/components/ui';
import { memo, useEffect, useMemo, useState } from 'react';
import { AudioLines, ChevronRight, Film, ImageIcon, ListTree, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import type { CanvasNodeTreeGroup } from '@/features/canvas/application/canvasNodeTree';

export type CanvasAssetKind = 'image' | 'video' | 'audio';

interface CanvasAssetItemBase {
  id: string;
  nodeId: string;
  kind: CanvasAssetKind;
  aspectRatio?: string;
  title: string;
  sourceLabel: string;
  order: number;
}

/** Sources are durable node values (asset-media refs, file paths, URLs); cards resolve them for display. */
export interface CanvasImageAssetItem extends CanvasAssetItemBase {
  kind: 'image';
  imageUrl: string;
  previewImageUrl?: string | null;
}

export interface CanvasVideoAssetItem extends CanvasAssetItemBase {
  kind: 'video';
  videoUrl: string;
}

export interface CanvasAudioAssetItem extends CanvasAssetItemBase { kind: 'audio'; audioUrl: string }
export type CanvasAssetItem = CanvasImageAssetItem | CanvasVideoAssetItem | CanvasAudioAssetItem;

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
  /** Browse mode: every content node grouped by type (the drawer's "nodes" tab). */
  tree?: CanvasNodeTreeGroup[];
  onLocateNode?: (nodeId: string) => void;
  onRenameNode?: (nodeId: string, title: string) => void;
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
  tree,
  onLocateNode,
  onRenameNode,
}: AssetPanelProps) => {
  const { t } = useTranslation();
  const [renamingNode, setRenamingNode] = useState<{ id: string; title: string } | null>(null);
  const [query, setQuery] = useState('');
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [activeKind, setActiveKind] = useState<CanvasAssetKind | 'tree'>('image');
  const showTree = mode === 'browse' && Boolean(tree);
  const imageCount = useMemo(() => assets.filter((asset) => asset.kind === 'image').length, [assets]);
  const videoCount = useMemo(() => assets.filter((asset) => asset.kind === 'video').length, [assets]);

  useEffect(() => {
    if (!isOpen) return;
    if (activeKind === 'tree') {
      if (!showTree) setActiveKind('image');
      return;
    }
    if (activeKind === 'image' && imageCount === 0 && videoCount > 0) {
      setActiveKind('video');
    }
    if (activeKind === 'video' && videoCount === 0 && imageCount > 0) {
      setActiveKind('image');
    }
  }, [activeKind, imageCount, isOpen, showTree, videoCount]);
  const filteredTree = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!tree || !normalized) return tree ?? [];
    return tree
      .map((group) => ({ ...group, items: group.items.filter((item) => item.title.toLowerCase().includes(normalized)) }))
      .filter((group) => group.items.length > 0);
  }, [query, tree]);

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
  const activeKindLabel = activeKind === 'image' ? '图片' : activeKind === 'video' ? '视频' : activeKind === 'audio' ? '音频' : '节点';

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
      className="fixed z-220 flex max-h-[540px] flex-col rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]"
      style={{ left: panelLeft, top: panelTop, width: panelWidth }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-text-dark">{title}</div>
          <div className="mt-0.5 text-[11px] text-text-subtle">{subtitle}</div>
        </div>
        <UiIconButton size="sm" onClick={onClose} aria-label="关闭资产面板" title="关闭资产面板">
          <X className="h-4 w-4" />
        </UiIconButton>
      </div>

      <div className="border-b border-[var(--line)] px-3 py-2">
        <UiSegmented<CanvasAssetKind | 'tree'>
          value={activeKind}
          onChange={setActiveKind}
          size="sm"
          className="w-full"
          options={[
            { value: 'image', icon: <ImageIcon className="h-3.5 w-3.5" />, label: <>图片 <span className="text-[10px] opacity-70">{imageCount}</span></> },
            { value: 'audio', label: t('rework.audio'), icon: <AudioLines /> },
            { value: 'video', icon: <Film className="h-3.5 w-3.5" />, label: <>视频 <span className="text-[10px] opacity-70">{videoCount}</span></> },
            ...(showTree ? [{ value: 'tree' as const, icon: <ListTree className="h-3.5 w-3.5" />, label: <>{t('rework.canvas.assets.nodes')} <span className="text-[10px] opacity-70">{tree?.reduce((sum, group) => sum + group.count, 0) ?? 0}</span></> }] : []),
          ]}
        />
      </div>

      <div className="border-b border-[var(--line)] px-3 py-2">
        <label className="relative flex h-8 items-center">
          <Search className="pointer-events-none absolute left-2 z-10 h-3.5 w-3.5 text-text-subtle" />
          <UiInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${activeKindLabel}名称`}
            className="h-8 min-w-0 flex-1 pl-7 pr-8 text-xs"
          />
          {query && (
            <UiIconButton size="sm" onClick={() => setQuery('')} aria-label="清空搜索" title="清空搜索" className="absolute right-1 h-6 w-6">
              <X className="h-3.5 w-3.5" />
            </UiIconButton>
          )}
        </label>
      </div>

      <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
        {activeKind === 'tree' ? (
          filteredTree.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-muted">{t(query ? 'rework.noMatches' : 'rework.canvas.assets.noNodes')}</p>
          ) : (
            <div className="space-y-1">
              {filteredTree.map((group) => (
                <details key={group.kind} open={Boolean(query) || filteredTree.length <= 3} className="group/tree rounded-lg">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-text-muted hover:bg-[var(--hover)] marker:content-none">
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-open/tree:rotate-90" />
                    <span className="flex-1">{t(`rework.canvas.assets.kinds.${group.kind}`)}</span>
                    <span className="text-[10px] text-text-subtle">{group.items.length}</span>
                  </summary>
                  <ul className="ml-5 mt-0.5 space-y-0.5">
                    {group.items.map((item) => (
                      <li key={item.nodeId}>
                        {renamingNode?.id === item.nodeId ? <input autoFocus className="ui-input h-8 w-full text-xs" value={renamingNode.title} onChange={(event) => setRenamingNode({ ...renamingNode, title: event.target.value })} onBlur={() => { if (renamingNode.title.trim()) onRenameNode?.(item.nodeId, renamingNode.title.trim()); setRenamingNode(null); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenamingNode(null); }} aria-label={t('rework.rename')} /> : <button type="button" className="w-full truncate rounded-md px-2 py-1 text-left text-xs text-text-dark hover:bg-[var(--hover)]"
                          title={item.title} onClick={() => onLocateNode?.(item.nodeId)} onDoubleClick={() => setRenamingNode({ id: item.nodeId, title: item.title })}>
                          {item.parentId ? <span className="mr-1 text-text-subtle">↳</span> : null}{item.title}
                        </button>}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )
        ) : assets.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--hover)] px-6 text-center">
            <ImageIcon className="mb-3 h-8 w-8 text-text-subtle" />
            <div className="text-sm text-text-muted">这个项目还没有资产</div>
            <div className="mt-1 text-[11px] leading-5 text-text-subtle">
              上传或生成图片、视频、故事板或全景图后，会自动出现在这里。
            </div>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-[var(--hover)] px-6 text-center">
            {query ? (
              <Search className="mb-3 h-7 w-7 text-text-subtle" />
            ) : activeKind === 'image' ? (
              <ImageIcon className="mb-3 h-7 w-7 text-text-subtle" />
            ) : (
              <Film className="mb-3 h-7 w-7 text-text-subtle" />
            )}
            <div className="text-sm text-text-muted">
              {query ? `没有匹配的${activeKindLabel}` : `这个项目还没有${activeKindLabel}资产`}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-text-subtle">
              {query ? '换个名称试试，或清空搜索查看全部资产。' : `切换到其他类型，或先在画布中创建${activeKindLabel}节点。`}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.label}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-medium text-text-muted">{group.label}</h3>
                  <span className="text-[10px] text-text-subtle">
                    {group.items.length} {activeKind === 'image' ? '张' : '个'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((asset) => (
                    <div
                      key={asset.id}
                      title={mode === 'select' ? `${asset.title} · 选择并连接` : `${asset.title} · 双击定位`}
                      className="group overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--hover)] text-left transition-colors hover:border-accent/70 hover:bg-accent/10"
                    >
                      <UiButton variant="ghost" type="button"
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
                      className="block h-auto aspect-square w-full overflow-hidden rounded-none p-0"
                      title={mode === 'select' ? `${asset.title} · 选择并连接` : `${asset.title} · 双击定位`}>{asset.kind === 'image' ? (
                        <AssetMedia
                          kind="image"
                          source={asset.previewImageUrl || asset.imageUrl}
                          alt={asset.title}
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                          draggable={false}
                        />
                      ) : (
                        <div className="relative h-full w-full bg-black">
                          <AssetMedia
                            kind={asset.kind}
                            source={asset.kind === 'audio' ? asset.audioUrl : asset.videoUrl}
                            className="h-full w-full object-cover opacity-90 transition-transform group-hover:scale-105"
                          />
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white">
                              <Film className="h-4 w-4" />
                            </span>
                          </div>
                        </div>
                      )}</UiButton>
                      <div className="space-y-0.5 px-2 py-1.5">
                        {mode === 'browse' ? (
                          <UiInput
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
                            className="nodrag h-6 w-full min-w-0 px-1.5 py-0.5 text-[10px] font-medium"
                            title="双击资产定位；这里可直接改名，允许同名"
                          />
                        ) : (
                          <div className="truncate rounded-sm border border-transparent px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                            {asset.title}
                          </div>
                        )}
                        <div className="truncate text-[9px] text-text-subtle">{asset.sourceLabel}</div>
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
