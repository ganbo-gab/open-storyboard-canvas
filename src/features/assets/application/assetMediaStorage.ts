import { isTauri } from '@tauri-apps/api/core';
import { persistImageSource, persistVideoSource } from '@/commands/image';

const DATABASE = 'storyboard-copilot:workspace';
let opening: Promise<IDBDatabase> | undefined;
const displayUrls = new Map<string, string>();
const sourceCommits = new Map<string, Promise<string>>();
const displayLoads = new Map<string, Promise<string>>();

function openDatabase(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked; close older application tabs'));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = undefined; }; resolve(db); };
  }).catch((error) => { opening = undefined; throw error; });
  return opening;
}
export async function readWorkspaceRecord<T>(store: 'documents' | 'media', key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as T | undefined);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
  });
}
export async function writeWorkspaceRecord(store: 'documents' | 'media', key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}
/** Media bytes are committed before a stable reference is returned. */
class StaleAssetBlobError extends Error {}
export async function persistAssetMedia(source: string, downloadRemote = false, kind?: 'image' | 'video' | 'audio'): Promise<string> {
  const remote = /^https?:\/\//i.test(source);
  if (!source.startsWith('blob:') && !source.startsWith('data:') && !(downloadRemote && remote)) return source;
  const cached = sourceCommits.get(source);
  if (cached) return await cached;
  const pending = commitAssetMedia(source, remote, kind);
  sourceCommits.set(source, pending);
  // Bound retained source strings, especially multi-megabyte data URLs. Live drafts
  // are canonicalized separately; evicted sources still deduplicate by content hash.
  if (sourceCommits.size > 8) sourceCommits.delete(sourceCommits.keys().next().value!);
  try { return await pending; }
  catch (error) { if (sourceCommits.get(source) === pending) sourceCommits.delete(source); throw error; }
}
async function commitAssetMedia(source: string, remote: boolean, kind?: 'image' | 'video' | 'audio'): Promise<string> {
  if (isTauri() && remote && (kind === 'image' || kind === 'video')) {
    return kind === 'image' ? await persistImageSource(source) : await persistVideoSource(source);
  }
  let response: Response;
  try { response = await fetch(source); }
  catch (error) {
    if (source.startsWith('blob:')) throw new StaleAssetBlobError('Legacy blob URL is unavailable after reload');
    throw error;
  }
  if (!response.ok) {
    if (source.startsWith('blob:')) throw new StaleAssetBlobError('Legacy blob URL is unavailable after reload');
    throw new Error('Cannot read media for local persistence');
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('Cannot persist empty media');
  if (remote && (/^(text\/|application\/(json|xhtml))/.test(blob.type) || (kind === 'image' && blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream'))) throw new Error('Result URL did not return media bytes');
  if (isTauri() && /^(image|video)\//.test(blob.type)) {
    const dataUrl = source.startsWith('data:') ? source : await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return blob.type.startsWith('image/') ? await persistImageSource(dataUrl) : await persistVideoSource(dataUrl);
  }
  return await persistAssetBlob(blob);
}

/** Binary asset boundary shared by uploaded models and existing image/audio/video media. */
export async function persistAssetBlob(blob: Blob): Promise<string> {
  if (!blob.size) throw new Error('Cannot persist empty media');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const reference = `asset-media:${encodeURIComponent(blob.type)}:${hash}`;
  const existing = await readWorkspaceRecord<Blob>('media', reference);
  if (!existing) await writeWorkspaceRecord('media', reference, blob);
  return reference;
}
export async function getAssetDisplaySource(source: string): Promise<string> {
  if (!source.startsWith('asset-media:')) return source;
  const existing = displayUrls.get(source);
  if (existing) return existing;
  const active = displayLoads.get(source);
  if (active) return await active;
  const pending = (async () => {
    const blob = await readWorkspaceRecord<Blob>('media', source);
    if (!blob) throw new Error('Persisted asset media is missing');
    const url = URL.createObjectURL(blob);
    displayUrls.set(source, url);
    return url;
  })();
  displayLoads.set(source, pending);
  try { return await pending; }
  finally { if (displayLoads.get(source) === pending) displayLoads.delete(source); }
}
/** Provider and legacy canvas boundaries need portable bytes, never an IndexedDB handle. */
export async function getAssetPortableSource(source: string): Promise<string> {
  if (!source.startsWith('asset-media:')) return source;
  const blob = await readWorkspaceRecord<Blob>('media', source);
  if (!blob) throw new Error('Persisted asset media is missing');
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read stored media'));
    reader.readAsDataURL(blob);
  });
}
/** Only declared media-source fields are externalized; prompts/text and arbitrary metadata strings stay intact. */
export async function externalizeAssetMedia<T>(value: T, tolerateStaleBlob = false): Promise<T> {
  const migrate = async (entry: unknown, mediaField: boolean, stale: { found: boolean }): Promise<unknown> => {
    if (typeof entry === 'string') {
      if (!mediaField) return entry;
      try { return await persistAssetMedia(entry); }
      catch (error) {
        if (!tolerateStaleBlob || !(error instanceof StaleAssetBlobError)) throw error;
        stale.found = true;
        return entry; // Preserve the original reference as evidence; never fabricate replacement media.
      }
    }
    if (Array.isArray(entry)) return await Promise.all(entry.map((item) => migrate(item, mediaField, stale)));
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    const isTask = typeof record.status === 'string' && Array.isArray(record.results) && typeof record.input === 'object';
    const isAsset = typeof record.origin === 'string' && typeof record.source === 'string';
    const local = isTask || isAsset ? { found: false } : stale;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === 'referenceSlots' && child && typeof child === 'object' && !Array.isArray(child)) {
        output[key] = Object.fromEntries(await Promise.all(Object.entries(child).map(async ([slot, sources]) => [slot, await migrate(sources, true, local)])));
        continue;
      }
      const sourceField = /^(source|previewUrl|imageUrl|previewImageUrl|videoUrl|localVideoUrl|audioUrl|localAudioUrl|thumbnailUrl|referenceImages|referenceVideos|referenceAudios)$/.test(key)
        || (key === 'result' && typeof record.job_id === 'string');
      output[key] = await migrate(child, sourceField && record.kind !== 'text', local);
    }
    if (local.found && isTask) {
      output.status = 'recoverable_wait';
      output.failure = { kind: 'interrupted', message: '旧会话的临时素材地址在刷新后已失效；原始记录与任务编号已保留，可仅取回原任务结果，不会重新提交。' };
    } else if (local.found && isAsset) {
      output.metadata = { ...(output.metadata as Record<string, unknown>), mediaPersistenceError: 'Legacy temporary media URL is unavailable; original reference preserved' };
    }
    return output;
  };
  return await migrate(value, typeof value === 'string', { found: false }) as T;
}
