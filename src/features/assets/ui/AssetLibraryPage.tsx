import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Heart,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  listAssets,
  saveAsset,
  favoriteAsset,
  deleteAssetReference,
  renameAsset,
  type AssetRecord,
  type AssetKind,
} from "../application/assetCatalog";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import { UiModal } from "@/components/ui";

import { AssetMedia, downloadAssetSource } from "./AssetMedia";
type Props = { onUseReference: () => void };
export function AssetLibraryPage({ onUseReference }: Props) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<AssetKind | "">("");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<AssetRecord | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      setAssets(await listAssets());
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
        const type: AssetKind = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "audio"
              : "text";
        const source =
          type === "text"
            ? await file.text()
            : await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(reader.error);
                reader.onload = () => resolve(String(reader.result));
                reader.readAsDataURL(file);
              });
        await saveAsset({
          kind: type,
          source,
          name: file.name,
          origin: "uploaded",
          metadata: { mime: file.type, size: file.size },
        });
      }
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };
  const visible = assets.filter(
    (asset) =>
      (!kind || asset.kind === kind) &&
      (!favorites || asset.favorite) &&
      `${asset.name} ${typeof asset.metadata.prompt === "string" ? asset.metadata.prompt : ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="ui-scrollbar h-full overflow-y-auto px-5 py-7 sm:px-9">
      <header className="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-text-dark">
          {t("rework.assets")}
        </h1>
        <button
          type="button"
          onClick={() => upload.current?.click()}
          className="flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-xs font-medium text-white"
        >
          <Upload className="h-4 w-4" />
          {t("rework.upload")}
        </button>
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
      <div className="mx-auto mb-6 flex max-w-6xl flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border-dark p-1">
          {(["", "image", "video", "audio", "text"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              className={`rounded-md px-3 py-2 text-xs ${kind === value ? "bg-text-dark/8 text-text-dark" : "text-text-muted hover:text-text-dark"}`}
            >
              {t(`rework.${value === "text" ? "chat" : value || "all"}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={favorites}
          onClick={() => setFavorites(!favorites)}
          className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs ${favorites ? "border-accent/40 text-accent" : "border-border-dark text-text-muted"}`}
        >
          <Heart className="h-3.5 w-3.5" />
          {t("rework.favorite")}
        </button>
        <label className="ml-auto flex h-10 items-center gap-2 rounded-lg border border-border-dark px-3">
          <Search className="h-4 w-4 text-text-muted" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("rework.assetSearch")}
            aria-label={t("rework.assetSearch")}
            className="w-36 bg-transparent text-xs text-text-dark outline-none sm:w-48"
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mx-auto mb-4 max-w-6xl text-sm text-red-400">
          {error}
        </p>
      )}
      {loading ? (
        <div role="status" className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
      ) : !visible.length ? (
        <p className="py-24 text-center text-sm text-text-muted">
          {t("rework.emptyAssets")}
        </p>
      ) : (
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((asset) => {
            const url =
              asset.kind === "text"
                ? ""
                : resolveImageDisplayUrl(asset.previewUrl || asset.source);
            return (
              <article
                key={asset.id}
                className="overflow-hidden rounded-xl border border-border-dark bg-surface-dark/50"
              >
                <button
                  type="button"
                  onClick={() => setView(asset)}
                  className="flex aspect-video w-full items-center justify-center overflow-hidden bg-bg-dark text-xs text-text-muted"
                  aria-label={`${t("rework.view")}: ${asset.name}`}
                >
                  {asset.kind === "image" ? (
                    <AssetMedia
                      source={asset.source}
                      kind="image"
                      alt={asset.name}
                      className="h-full w-full object-contain"
                    />
                  ) : asset.kind === "video" ? (
                    <AssetMedia
                      source={asset.source}
                      kind="video"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <span className="line-clamp-3 px-5 leading-6">
                      {asset.kind === "text" ? asset.source : asset.name}
                    </span>
                  )}
                </button>
                <div className="p-3">
                  <div className="truncate text-xs font-medium text-text-dark">
                    {asset.name}
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <button
                      type="button"
                      title={t("rework.favorite")}
                      aria-pressed={asset.favorite}
                      onClick={() =>
                        void mutate(favoriteAsset(asset.id, !asset.favorite))
                      }
                      className="rounded-lg p-2 text-text-muted hover:bg-bg-dark"
                    >
                      <Heart
                        className={`h-3.5 w-3.5 ${asset.favorite ? "fill-accent text-accent" : ""}`}
                      />
                    </button>
                    {url && (
                      <button
                        type="button"
                        onClick={() =>
                          void downloadAssetSource(
                            asset.source,
                            asset.name,
                          ).catch((cause: unknown) => setError(String(cause)))
                        }
                        title={t("rework.download")}
                        className="rounded-lg p-2 text-text-muted hover:bg-bg-dark"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("rework.rename")}
                      onClick={() => {
                        const name = window.prompt(
                          t("rework.name"),
                          asset.name,
                        );
                        if (name?.trim())
                          void mutate(renameAsset(asset.id, name));
                      }}
                      className="rounded-lg p-2 text-text-muted hover:bg-bg-dark"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("rework.useReference")}
                      onClick={() => {
                        const state = useWorkbenchStore.getState();
                        state.setDraft({
                          references: [
                            ...(state.draft.references ?? []),
                            {
                              id: crypto.randomUUID(),
                              kind: asset.kind,
                              source: asset.source,
                              name: asset.name,
                            },
                          ],
                        });
                        onUseReference();
                      }}
                      className="rounded-lg p-2 text-text-muted hover:bg-bg-dark"
                    >
                      <WandSparkles className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("rework.delete")}
                      onClick={() => {
                        if (window.confirm(t("rework.confirmDelete")))
                          void mutate(deleteAssetReference(asset.id));
                      }}
                      className="ml-auto rounded-lg p-2 text-text-muted hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
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
