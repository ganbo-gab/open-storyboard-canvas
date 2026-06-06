export function formatGenerationElapsedMs(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const elapsedMs = Math.max(0, Math.floor(value));
  if (elapsedMs < 60000) {
    return `${(Math.floor(elapsedMs / 100) / 10).toFixed(1)}s`;
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
