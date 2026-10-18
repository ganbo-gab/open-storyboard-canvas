import { useEffect, useState } from "react";
import { getAssetDisplaySource } from "../application/assetCatalog";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

type Props = {
  source: string;
  kind: "image" | "video" | "audio";
  alt?: string;
  className?: string;
  controls?: boolean;
  onClick?: () => void;
};
export function AssetMedia({
  source,
  kind,
  alt = "",
  className = "",
  controls = false,
  onClick,
}: Props) {
  const [url, setUrl] = useState(
    source.startsWith("asset-media:") ? "" : resolveImageDisplayUrl(source),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    if (!source.startsWith("asset-media:")) {
      setUrl(resolveImageDisplayUrl(source));
      return;
    }
    setUrl("");
    void getAssetDisplaySource(source)
      .then((value) => {
        if (active) setUrl(resolveImageDisplayUrl(value));
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [source]);
  if (error)
    return (
      <span role="alert" className="block break-words p-3 text-xs text-red-400">
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
