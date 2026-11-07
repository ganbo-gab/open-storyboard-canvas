/** Sources accepted by generic image-node creation; never session URLs or executable/file schemes. */
export function isDurableCanvasImageSource(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^asset-media:(?:image%2F|image\/)[^:]+:[a-f0-9]{64}$/i.test(value)) return true;
  // Tauri persists generated/uploaded media as absolute filesystem paths.
  if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value)) return /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(value);
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'asset:')
      && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
