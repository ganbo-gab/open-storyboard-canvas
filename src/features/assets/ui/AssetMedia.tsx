import { getAssetDisplaySource } from "../application/assetCatalog";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useAssetDisplaySource } from "./useAssetDisplaySource";

type Props = {
  source: string;
  kind: "image" | "video" | "audio";
  alt?: string;
  className?: string;
  controls?: boolean;
  onClick?: () => void;
  draggable?: boolean;
};
export function AssetMedia({
  source,
  kind,
  alt = "",
  className = "",
  controls = false,
  onClick,
  draggable,
}: Props) {
  const { url, error } = useAssetDisplaySource(source);
  if (error)
    return (
      <span role="alert" className="block break-words p-3 text-xs text-danger">
        {error}
      </span>
    );
  if (!url)
    return (
      <span
        className={`block animate-pulse rounded-lg bg-text-dark/5 ${className}`}
      />
    );
  if (kind === "video")
    return (
      <video
        src={url}
        controls={controls}
        preload="metadata"
        className={className}
        onClick={onClick}
        draggable={draggable}
      />
    );
  if (kind === "audio")
    return (
      <audio
        src={url}
        controls={controls}
        preload="metadata"
        className={className}
      />
    );
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      loading="lazy"
      onClick={onClick}
      draggable={draggable}
    />
  );
}
export async function downloadAssetSource(source: string, name = "asset") {
  const url = resolveImageDisplayUrl(await getAssetDisplaySource(source));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noreferrer";
  anchor.target = "_blank";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
