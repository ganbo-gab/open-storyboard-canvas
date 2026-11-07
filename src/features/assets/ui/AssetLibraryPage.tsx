import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  SlidersHorizontal,
  Download,
  FileText,
  Film,
  Heart,
  Images,
  LayoutGrid,
  Music2,
  Pencil,
  Play,
  Search,
  SendToBack,
  Tag,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  listAssets,
  favoriteAsset,
  deleteAssetReferences,
  filterAssets,
  groupAssetsByDate,
  renameAsset,
  tagAssets,
  type AssetQuery,
  type AssetRecord,
  type AssetKind,
} from "../application/assetCatalog";
import { useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import { importAssetFile } from "../application/assetFiles";
import { downloadAssets } from "../application/assetDownloads";
import { RenameDialog } from "@/features/project/RenameDialog";
import { writeStudioMediaDrag } from "@/features/studio/mediaDrag";
import { MediaImportDialog } from "@/features/studio/MediaImportDialog";
import { UiButton, UiChipButton, UiConfirm, UiModal, UiSelect } from "@/components/ui";
import { openMediaViewer, closeMediaViewer, type MediaViewerItem } from '@/features/viewer/viewerStore';
import { AssetMedia } from "./AssetMedia";
import { AssetEditDialog } from './AssetEditDialog';

const KIND_FILTERS: { id: AssetKind | ""; icon: typeof Images }[] = [
  { id: "", icon: LayoutGrid },
  { id: "image", icon: Images },
  { id: "video", icon: Film },
  { id: "audio", icon: Music2 },
  { id: "text", icon: FileText },
];
const ORIGIN_FILTERS: { id: NonNullable<AssetQuery["origin"]>; label: string }[] = [
  { id: "upload", label: "rework.assetOrigin.upload" },
  { id: "generated", label: "rework.assetOrigin.generated" },
  { id: "canvas", label: "rework.assetOrigin.canvas" },
];

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}
function assetRatio(asset: AssetRecord): string | undefined {
  const config = asset.metadata.config;
  return stringField(asset.metadata, "aspectRatio") ?? stringField(asset.metadata, "aspect_ratio")
    ?? (config !== null && typeof config === "object" ? stringField(config as Record<string, unknown>, "aspectRatio") : undefined);
}
function assetModel(asset: AssetRecord): string | undefined {
  return stringField(asset.metadata, "model") ?? stringField(asset.metadata, "sourceModelId");
}
function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

type Props = { onUseReference: () => void };
export function AssetLibraryPage({ onUseReference }: Props) {
  const [editing, setEditing] = useState<AssetRecord | null>(null);
  const { t, i18n } = useTranslation();
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<AssetKind | "">("");
  const [origin, setOrigin] = useState<AssetQuery["origin"]>(undefined);
  const [ratio, setRatio] = useState("");
  const [model, setModel] = useState("");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<AssetRecord | null>(null);
  const [renaming, setRenaming] = useState<AssetRecord | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [tagging, setTagging] = useState<string[] | null>(null);
  const [sending, setSending] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await listAssets();
      setAssets(next);
      // Drop selections whose references were deleted elsewhere.
      setSelected((current) => current.filter((id) => next.some((asset) => asset.id === id)));
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (action: Promise<void>) => {
    try {
      await action;
      await refresh();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const addFiles = async (files: FileList) => {
    setLoading(true);
    try {
      for (const file of Array.from(files)) {
        await importAssetFile(file);
      }
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };
  const ratios = useMemo(() => distinct(assets.map(assetRatio)), [assets]);
  const models = useMemo(() => distinct(assets.map(assetModel)), [assets]);
  const visible = useMemo(() => filterAssets(assets, {
    kind: kind || undefined,
    origin,
    ratio: ratio || undefined,
    model: model || undefined,
    text: search,
    favorite: favorites ? true : undefined,
  }), [assets, kind, origin, ratio, model, search, favorites]);
  const groups = useMemo(() => groupAssetsByDate(visible), [visible]);
  const counts = assets.reduce<Record<string, number>>((acc, asset) => {
    acc[asset.kind] = (acc[asset.kind] ?? 0) + 1;
    return acc;
  }, {});
  const selecting = selected.length > 0;
  const toggleSelected = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  const useAsReference = (asset: AssetRecord) => {
    const state = useWorkbenchStore.getState();
    state.setDraft({
      references: [
        ...(state.draft.references ?? []),
        { id: crypto.randomUUID(), kind: asset.kind, source: asset.source, name: asset.name },
      ],
    });
    onUseReference();
  };
  /** Originals, not previews; sequential so the platform save dialogs/downloads never race. */
  const downloadMany = async (ids: string[]) => {
    setBusy(true);
    setError("");
    try {
      await downloadAssets(ids);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const viewAsset = (asset: AssetRecord) => {
    if (asset.kind === 'text') { setView(asset); return; }
    const items: MediaViewerItem[] = visible.flatMap((entry) => entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio' ? [{
      id: entry.id, kind: entry.kind, source: entry.source, title: entry.name, prompt: stringField(entry.metadata, 'prompt'),
      facts: [{ label: t('ui.viewer.model'), value: assetModel(entry) ?? '—' }],
      actions: [
        { id: 'edit', label: '编辑内容', icon: <SlidersHorizontal />, run: () => { closeMediaViewer(); setEditing(entry); } },
        { id: 'reference', label: t('rework.useReference'), icon: <WandSparkles />, run: () => { closeMediaViewer(); useAsReference(entry); } },
        { id: 'canvas', label: t('rework.sendToCanvas'), icon: <SendToBack />, run: () => { closeMediaViewer(); setSending([entry.id]); } },
        { id: 'favorite', label: t('rework.favorite'), icon: <Heart />, run: async () => { await favoriteAsset(entry.id, !entry.favorite); await refresh(); } },
      ],
    }] : []);
    openMediaViewer(items, Math.max(0, items.findIndex((entry) => entry.id === asset.id)));
  };
  const dateLabel = (period: "today" | "yesterday" | "earlier", date: number) =>
    period === "earlier"
      ? new Date(date).toLocaleDateString(i18n.language, { year: "numeric", month: "long", day: "numeric" })
      : t(`rework.assetDate.${period}`);
  return (
    <div className="studio-page ui-scrollbar h-full overflow-y-auto px-6 py-8 sm:px-10">
      <header className="mx-auto mb-6 flex max-w-[1180px] flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-dark">
          {t("rework.assets")}
        </h1>
        <UiButton variant="primary" icon={<Upload />} onClick={() => upload.current?.click()}>
          {t("rework.upload")}
        </UiButton>
        <input
          ref={upload}
          hidden
          type="file"
          multiple
          accept="image/*,video/*,audio/*,text/*"
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </header>
      <div className="mx-auto mb-3 flex max-w-[1180px] flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t("rework.mode")} className="flex flex-wrap gap-1">
          {KIND_FILTERS.map((item) => (
            <UiChipButton
              key={item.id}
              role="radio"
              aria-checked={kind === item.id}
              active={kind === item.id}
              onClick={() => setKind(item.id)}
            >
              <item.icon />
              {t(`rework.${item.id === "text" ? "chat" : item.id || "all"}`)}
              <span className="text-[11px] opacity-60">
                {item.id ? counts[item.id] ?? 0 : assets.length}
              </span>
            </UiChipButton>
          ))}
        </div>
        <UiChipButton aria-pressed={favorites} active={favorites} onClick={() => setFavorites(!favorites)}>
          <Heart className={favorites ? "fill-current" : ""} />
          {t("rework.favorite")}
        </UiChipButton>
        <label className="ui-input ml-auto !w-56 items-center gap-2 rounded-full px-3 max-sm:!w-full">
          <Search className="h-4 w-4 shrink-0 text-text-subtle" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("rework.assetSearch")}
            aria-label={t("rework.assetSearch")}
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none"
          />
        </label>
      </div>
      <div className="mx-auto mb-6 flex max-w-[1180px] flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t("rework.assetOrigin.label")} className="flex flex-wrap gap-1">
          <UiChipButton role="radio" aria-checked={!origin} active={!origin} onClick={() => setOrigin(undefined)}>
            {t("rework.assetOrigin.all")}
          </UiChipButton>
          {ORIGIN_FILTERS.map((item) => (
            <UiChipButton key={item.id} role="radio" aria-checked={origin === item.id} active={origin === item.id} onClick={() => setOrigin(item.id)}>
              {t(item.label)}
            </UiChipButton>
          ))}
        </div>
        {ratios.length > 0 && (
          <UiSelect aria-label={t("rework.ratio")} value={ratio} onChange={(event) => setRatio(event.target.value)} className="h-[30px] w-auto min-w-[96px] rounded-full text-xs">
            <option value="">{t("rework.ratio")}</option>
            {ratios.map((value) => <option key={value} value={value}>{value}</option>)}
          </UiSelect>
        )}
        {models.length > 0 && (
          <UiSelect aria-label={t("rework.assetModel")} value={model} onChange={(event) => setModel(event.target.value)} className="h-[30px] w-auto min-w-[120px] max-w-[220px] rounded-full text-xs">
            <option value="">{t("rework.assetModel")}</option>
            {models.map((value) => <option key={value} value={value}>{value.split(":").slice(2).join(":") || value}</option>)}
          </UiSelect>
        )}
        <span className="ml-auto text-[11.5px] text-text-subtle">{t("rework.assetSelectHint")}</span>
      </div>
      {selecting && (
        <div role="toolbar" aria-label={t("rework.assetBatch.label")} className="studio-batch-bar mx-auto mb-4 max-w-[1180px]">
          <span className="text-xs font-medium text-text-dark">{t("rework.assetBatch.selected", { count: selected.length })}</span>
          <UiButton size="sm" variant="ghost" onClick={() => setSelected(visible.map((asset) => asset.id))}>{t("rework.assetBatch.selectAll")}</UiButton>
          <span className="flex-1" />
          <UiButton size="sm" variant="ghost" icon={<Download />} loading={busy} onClick={() => void downloadMany(selected)}>{t("rework.download")}</UiButton>
          <UiButton size="sm" variant="ghost" icon={<Tag />} onClick={() => setTagging(selected)}>{t("rework.assetBatch.tag")}</UiButton>
          <UiButton size="sm" variant="ghost" icon={<SendToBack />} onClick={() => setSending(selected)}>{t("rework.sendToCanvas")}</UiButton>
          <UiButton size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(selected)}>{t("rework.delete")}</UiButton>
          <UiButton size="sm" variant="ghost" icon={<X />} aria-label={t("rework.assetBatch.clear")} onClick={() => setSelected([])}>{t("rework.assetBatch.clear")}</UiButton>
        </div>
      )}
      {error && (
        <p role="alert" className="mx-auto mb-4 max-w-[1180px] text-sm text-danger">
          {error}
        </p>
      )}
      {loading ? (
        <div role="status" aria-label={t("common.loading")} className="mx-auto grid max-w-[1180px] grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, index) => <span key={index} className="studio-skeleton aspect-square" />)}
        </div>
      ) : !visible.length ? (
        <div className="mx-auto flex max-w-sm flex-col items-center py-24 text-center">
          <span className="studio-tool__icon mb-4"><Images /></span>
          <p className="text-sm text-text-muted">{t(assets.length ? "rework.noMatches" : "rework.emptyAssets")}</p>
        </div>
      ) : (
        <div className="mx-auto max-w-[1180px] space-y-6">
          {groups.map((group) => (
            <section key={group.key} aria-label={dateLabel(group.period, group.date)}>
              <h2 className="mb-2 text-[12.5px] font-medium text-text-muted">
                {dateLabel(group.period, group.date)} <span className="text-text-subtle">· {group.assets.length}</span>
              </h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
                {group.assets.map((asset) => {
                  const isSelected = selected.includes(asset.id);
                  return (
                    <div
                      key={asset.id}
                      className="studio-card-host relative"
                      data-selected={isSelected || undefined}
                      draggable
                      onDragStart={(event) => {
                        // Dragging a selected card moves the whole selection; otherwise just this one.
                        writeStudioMediaDrag(event.dataTransfer, { kind: "asset", assetIds: isSelected ? selected : [asset.id] });
                      }}
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          if (selecting || event.shiftKey || event.metaKey || event.ctrlKey) toggleSelected(asset.id);
                          else viewAsset(asset);
                        }}
                        className="studio-card w-full"
                        aria-label={`${t("rework.view")}: ${asset.name}`}
                      >
                        <span className="studio-card__media block aspect-square">
                          {asset.kind === "image" || asset.kind === "video" ? (
                            <AssetMedia
                              source={asset.kind === "image" ? asset.previewUrl || asset.source : asset.source}
                              kind={asset.kind}
                              alt={asset.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="flex h-full w-full flex-col items-center justify-center gap-3 p-5 text-text-muted">
                              {asset.kind === "audio" ? <AudioLines className="h-7 w-7" /> : <FileText className="h-6 w-6" />}
                              <span className="line-clamp-4 text-center text-xs leading-5">
                                {asset.kind === "text" ? asset.source : asset.name}
                              </span>
                            </span>
                          )}
                          {asset.kind === "video" && (
                            <span className="studio-card__badge"><Play />{t("rework.video")}</span>
                          )}
                          {asset.favorite && (
                            <span className="studio-card__badge left-auto right-2 px-1.5" aria-label={t("rework.favorite")}>
                              <Heart className="fill-current" />
                            </span>
                          )}
                          <span className="studio-card__overlay">
                            <span className="truncate text-xs font-medium">{asset.name}</span>
                            {typeof asset.metadata.projectName === "string" && (
                              <span className="truncate text-[11px] opacity-75">{asset.metadata.projectName}</span>
                            )}
                            {!!asset.tags?.length && (
                              <span className="truncate text-[10.5px] opacity-75">#{asset.tags.join(" #")}</span>
                            )}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={t("rework.assetBatch.select", { name: asset.name })}
                        className="studio-card__check"
                        onClick={() => toggleSelected(asset.id)}
                      >
                        {isSelected && <Check />}
                      </button>
                      <div className="studio-card__actions">
                        <button type="button" title="编辑内容" aria-label={`编辑内容：${asset.name}`} onClick={() => setEditing(asset)}><SlidersHorizontal /></button>
                        <button
                          type="button"
                          title={t("rework.favorite")}
                          aria-label={t("rework.favorite")}
                          aria-pressed={asset.favorite}
                          onClick={() => void mutate(favoriteAsset(asset.id, !asset.favorite))}
                        >
                          <Heart className={asset.favorite ? "fill-current" : ""} />
                        </button>
                        {asset.kind !== "text" && (
                          <button
                            type="button"
                            title={t("rework.download")}
                            aria-label={t("rework.download")}
                            onClick={() => void downloadMany([asset.id])}
                          >
                            <Download />
                          </button>
                        )}
                        <button
                          type="button"
                          title={t("rework.useReference")}
                          aria-label={t("rework.useReference")}
                          onClick={() => useAsReference(asset)}
                        >
                          <WandSparkles />
                        </button>
                        <button
                          type="button"
                          title={t("rework.sendToCanvas")}
                          aria-label={t("rework.sendToCanvas")}
                          onClick={() => setSending([asset.id])}
                        >
                          <SendToBack />
                        </button>
                        <button
                          type="button"
                          title={t("rework.rename")}
                          aria-label={t("rework.rename")}
                          onClick={() => setRenaming(asset)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          data-tone="danger"
                          title={t("rework.delete")}
                          aria-label={t("rework.delete")}
                          onClick={() => setDeleting([asset.id])}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      <RenameDialog
        isOpen={!!renaming}
        title={t("rework.rename")}
        defaultValue={renaming?.name ?? ""}
        onClose={() => setRenaming(null)}
        onConfirm={(name) => renaming && void mutate(renameAsset(renaming.id, name))}
      />
      <RenameDialog
        isOpen={!!tagging}
        title={t("rework.assetBatch.tagTitle", { count: tagging?.length ?? 0 })}
        defaultValue=""
        onClose={() => setTagging(null)}
        onConfirm={(value) => {
          const tags = value.split(/[,，#\s]+/).map((tag) => tag.trim()).filter(Boolean);
          if (tagging && tags.length) void mutate(tagAssets(tagging, tags));
        }}
      />
      <UiConfirm
        isOpen={!!deleting}
        title={t("rework.delete")}
        description={t("rework.assetBatch.deleteConfirm", { count: deleting?.length ?? 0 })}
        confirmLabel={t("rework.delete")}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const ids = deleting;
          setSelected((current) => current.filter((id) => !ids.includes(id)));
          void mutate(deleteAssetReferences(ids));
        }}
      />
      {sending && <MediaImportDialog payload={{ kind: "asset", assetIds: sending }} onClose={() => setSending(null)} />}
      {editing && <AssetEditDialog asset={editing} onClose={() => setEditing(null)} onSaved={async () => { await refresh(); }} />}
      <UiModal
        isOpen={!!view}
        title={view?.name ?? ""}
        onClose={() => setView(null)}
        widthClassName="w-[min(1100px,calc(100vw-2rem))]"
      >
        {view &&
          (view.kind === "image" ? (
            <AssetMedia
              source={view.source}
              kind="image"
              alt={view.name}
              className="max-h-[70vh] w-full object-contain"
            />
          ) : view.kind === "video" ? (
            <AssetMedia
              source={view.source}
              kind="video"
              controls
              className="max-h-[70vh] w-full"
            />
          ) : view.kind === "audio" ? (
            <AssetMedia
              source={view.source}
              kind="audio"
              controls
              className="w-full"
            />
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm leading-7 text-text-dark">
              {view.source}
            </pre>
          ))}
      </UiModal>
    </div>
  );
}
