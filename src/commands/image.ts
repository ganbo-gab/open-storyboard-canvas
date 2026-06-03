import { invoke } from '@tauri-apps/api/core';

export async function splitImage(
  imageBase64: string,
  rows: number,
  cols: number,
  lineThickness = 0
): Promise<string[]> {
  return await invoke('split_image', {
    imageBase64,
    rows,
    cols,
    lineThickness,
  });
}

export async function splitImageSource(
  source: string,
  rows: number,
  cols: number,
  lineThickness = 0
): Promise<string[]> {
  return await invoke('split_image_source', {
    source,
    rows,
    cols,
    lineThickness,
  });
}

export interface MergeStoryboardImagesPayload {
  frameSources: string[];
  rows: number;
  cols: number;
  cellGap: number;
  outerPadding: number;
  noteHeight: number;
  fontSize: number;
  backgroundColor: string;
  maxDimension: number;
  showFrameIndex?: boolean;
  showFrameNote?: boolean;
  notePlacement?: 'overlay' | 'bottom';
  imageFit?: 'cover' | 'contain';
  frameIndexPrefix?: string;
  textColor?: string;
  frameNotes?: string[];
}

export interface StoryboardImageMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

export interface PrepareNodeImageSourceResult {
  imagePath: string;
  previewImagePath: string;
  aspectRatio: string;
}

export interface RenameLocalMediaFilesPayload {
  primaryPath: string;
  previewPath?: string;
  desiredFileName?: string;
  mediaKind: 'image' | 'video';
}

export interface RenameLocalMediaFilesResult {
  primaryPath: string;
  previewPath?: string;
  fileName: string;
}

export interface CropImageSourcePayload {
  source: string;
  aspectRatio?: string;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
}

export interface MergeStoryboardImagesResult {
  imagePath: string;
  canvasWidth: number;
  canvasHeight: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  padding: number;
  noteHeight: number;
  fontSize: number;
  textOverlayApplied: boolean;
}

export async function mergeStoryboardImages(
  payload: MergeStoryboardImagesPayload
): Promise<MergeStoryboardImagesResult> {
  return await invoke('merge_storyboard_images', { payload });
}

export async function readStoryboardImageMetadata(
  source: string
): Promise<StoryboardImageMetadata | null> {
  return await invoke('read_storyboard_image_metadata', { source });
}

export async function embedStoryboardImageMetadata(
  source: string,
  metadata: StoryboardImageMetadata
): Promise<string> {
  return await invoke('embed_storyboard_image_metadata', { source, metadata });
}

export async function prepareNodeImageSource(
  source: string,
  maxPreviewDimension = 512
): Promise<PrepareNodeImageSourceResult> {
  return await invoke('prepare_node_image_source', {
    source,
    maxPreviewDimension,
  });
}

export async function prepareNodeImageSourceWithHeaders(
  source: string,
  headers: Record<string, string>,
  maxPreviewDimension = 512
): Promise<PrepareNodeImageSourceResult> {
  return await invoke('prepare_node_image_source_with_headers', {
    source,
    headers,
    maxPreviewDimension,
  });
}

export async function prepareNodeImageBinary(
  bytes: Uint8Array,
  extension?: string,
  maxPreviewDimension = 512
): Promise<PrepareNodeImageSourceResult> {
  return await invoke('prepare_node_image_binary', {
    bytes: Array.from(bytes),
    extension,
    maxPreviewDimension,
  });
}

export async function cropImageSource(
  payload: CropImageSourcePayload
): Promise<string> {
  return await invoke('crop_image_source', { payload });
}

export async function loadImage(filePath: string): Promise<string> {
  return await invoke('load_image', {
    filePath,
  });
}

export async function persistImageSource(source: string): Promise<string> {
  return await invoke('persist_image_source', { source });
}

export async function persistVideoSource(
  source: string,
  headers?: Record<string, string>
): Promise<string> {
  return await invoke('persist_video_source', { source, headers });
}

export async function persistImageBinary(
  bytes: Uint8Array,
  extension = 'png'
): Promise<string> {
  return await invoke('persist_image_binary', {
    bytes: Array.from(bytes),
    extension,
  });
}

export async function renameLocalMediaFiles(
  payload: RenameLocalMediaFilesPayload
): Promise<RenameLocalMediaFilesResult> {
  return await invoke('rename_local_media_files', { payload });
}

export async function saveImageSourceToDownloads(
  source: string,
  suggestedFileName?: string
): Promise<string> {
  return await invoke('save_image_source_to_downloads', {
    source,
    suggestedFileName,
  });
}

export async function saveImageSourceToPath(
  source: string,
  targetPath: string
): Promise<string> {
  return await invoke('save_image_source_to_path', {
    source,
    targetPath,
  });
}

export async function saveImageSourceToDirectory(
  source: string,
  targetDir: string,
  suggestedFileName?: string
): Promise<string> {
  return await invoke('save_image_source_to_directory', {
    source,
    targetDir,
    suggestedFileName,
  });
}

export async function saveVideoSourceToPath(
  source: string,
  targetPath: string
): Promise<string> {
  return await invoke('save_video_source_to_path', {
    source,
    targetPath,
  });
}

export async function saveVideoSourceToDirectory(
  source: string,
  targetDir: string,
  suggestedFileName?: string
): Promise<string> {
  return await invoke('save_video_source_to_directory', {
    source,
    targetDir,
    suggestedFileName,
  });
}

export async function saveImageSourceToAppDebugDir(
  source: string,
  category = 'grid',
  suggestedFileName?: string
): Promise<string> {
  return await invoke('save_image_source_to_app_debug_dir', {
    source,
    category,
    suggestedFileName,
  });
}

export async function copyImageSourceToClipboard(source: string): Promise<void> {
  await invoke('copy_image_source_to_clipboard', { source });
}
