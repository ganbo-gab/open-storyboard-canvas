const COMMON_IMAGE_FILE_EXTENSION_PATTERN =
  /\.(?:png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?|svg)$/i;

export function isImageFile(file: File | null | undefined): file is File {
  if (!file) {
    return false;
  }
  if (file.type.startsWith('image/')) {
    return true;
  }
  return COMMON_IMAGE_FILE_EXTENSION_PATTERN.test(file.name);
}

export function dataTransferHasFile(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (Array.from(dataTransfer.types || []).some(
    (type) => type.toLowerCase() === 'files'
  )) {
    return true;
  }

  if (Array.from(dataTransfer.items || []).some((item) => item.kind === 'file')) {
    return true;
  }

  return Array.from(dataTransfer.files || []).length > 0;
}

export function dataTransferHasImageFile(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (Array.from(dataTransfer.items || []).some((item) => (
    item.kind === 'file'
    && (
      item.type.startsWith('image/')
      || item.type === ''
      || item.type === 'application/octet-stream'
      || COMMON_IMAGE_FILE_EXTENSION_PATTERN.test(item.getAsFile()?.name ?? '')
    )
  ))) {
    return true;
  }

  return Array.from(dataTransfer.files || []).some(isImageFile);
}

export function resolveDroppedImageFile(dataTransfer: DataTransfer | null | undefined): File | null {
  if (!dataTransfer) {
    return null;
  }

  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (isImageFile(file)) {
      return file;
    }
  }

  return Array.from(dataTransfer.files || []).find(isImageFile) ?? null;
}
