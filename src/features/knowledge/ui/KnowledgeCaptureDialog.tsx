import { useState } from 'react';
import { create } from 'zustand';
import { isTauri } from '@tauri-apps/api/core';
import { FolderOpen, NotebookPen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiInput, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectNodeIdsWithDescendants } from '@/features/canvas/clipboard/clipboardIO';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { getGeneratedTextForConnection } from '@/features/canvas/application/nodeText';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import { requestStudioPageNavigation } from '@/features/studio/studioNavigation';
import { useKnowledgeStore } from '../application/knowledgeStore';
import { assertVaultRelativePath, type CanvasNodeSnapshot } from '../domain/types';

const useCaptureTarget = create<{ nodeIds: string[] | null }>(() => ({ nodeIds: null }));
export function openKnowledgeCapture(nodeIds: string[]): void { useCaptureTarget.setState({ nodeIds: [...nodeIds] }); }
export function KnowledgeCaptureDialogHost() {
  const nodeIds = useCaptureTarget(state => state.nodeIds);
  return nodeIds ? <KnowledgeCaptureDialog nodeIds={nodeIds} onClose={() => useCaptureTarget.setState({ nodeIds: null })} /> : null;
}

/** Snapshot is taken on open, before any async file work or later canvas changes. */
export function KnowledgeCaptureDialog({ nodeIds, onClose }: { nodeIds: string[]; onClose(): void }) {
  const { t } = useTranslation();
  const status = useKnowledgeStore(state => state.status);
  const vaultPath = useKnowledgeStore(state => state.vaultPath);
  const [snapshots] = useState<CanvasNodeSnapshot[]>(() => {
    const { nodes } = useCanvasStore.getState();
    const selected = new Set(collectNodeIdsWithDescendants(nodes, nodeIds));
    return nodes.filter(node => selected.has(node.id)).map(node => {
      const params: Record<string, unknown> = {};
      for (const key of ['modelConfig', 'model', 'providerId', 'aspectRatio', 'videoConfig', 'cameraControl', 'extraParams', 'channelModeId']) {
        if (node.data[key] !== undefined) params[key] = structuredClone(redactSensitiveValue(node.data[key]));
      }
      const prompt = typeof node.data.prompt === 'string' ? node.data.prompt : typeof node.data.sourcePrompt === 'string' ? node.data.sourcePrompt : '';
      const text = getGeneratedTextForConnection(node, nodes);
      return { kind: node.type, title: resolveNodeDisplayName(node.type, node.data), prompt: [prompt, text].filter(Boolean).join('\n\n'), params,
        media: buildCanvasAssetCatalog([node]).map(asset => {
          const sourceName = asset.url.split(/[\\/]/).at(-1)?.split('?')[0];
          const mime = /^asset-media:([^:]+):/.exec(asset.url)?.[1];
          const subtype = mime ? decodeURIComponent(mime).split('/')[1] : undefined;
          const extension = subtype === 'jpeg' ? 'jpg' : subtype?.replace(/[^a-z0-9]/gi, '');
          const name = sourceName && /\.[a-z0-9]{2,5}$/i.test(sourceName) ? sourceName : `${asset.title}${extension ? `.${extension}` : ''}`;
          return { reference: asset.url, name };
        }) };
    });
  });
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState('');
  const remote = snapshots.some(snapshot => snapshot.media.some(media => /^https?:\/\//i.test(media.reference)));
  const choose = async () => {
    setBusy(true); setError('');
    try { await useKnowledgeStore.getState().chooseVault(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy || attempted || status !== 'ready' || remote) return;
    setBusy(true); setAttempted(true); setError('');
    try {
      if (folder.trim()) assertVaultRelativePath(folder.trim());
      for (const snapshot of snapshots) {
        const result = await useKnowledgeStore.getState().ingest({ kind: 'canvas', snapshot, folder: folder.trim() || undefined });
        setPaths(current => [...current, result.notePath]);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <UiModal isOpen title={t('rework.knowledge.captureTitle')} onClose={() => { if (!busy) onClose(); }} widthClassName="w-[min(620px,calc(100vw-1.5rem))]"
    footer={<><UiButton variant="ghost" disabled={busy} onClick={onClose}>{t('common.close')}</UiButton>{paths.length > 0 ? <UiButton variant="primary" icon={<NotebookPen />} disabled={busy} onClick={() => { requestStudioPageNavigation('knowledge'); onClose(); }}>{t('rework.knowledge.openVault')}</UiButton> : <UiButton variant="primary" loading={busy} disabled={!snapshots.length || attempted || remote || status !== 'ready'} onClick={() => void save()}>{t('common.save')}</UiButton>}</>}>
    <div className="space-y-4"><p className="text-xs leading-6 text-text-muted">{t('rework.knowledge.captureHint', { count: snapshots.length })}</p>{vaultPath && <p className="break-all text-xs text-text-subtle">{vaultPath}</p>}
      {status !== 'ready' && <div className="space-y-2"><UiButton size="sm" icon={<FolderOpen />} disabled={busy || !isTauri()} onClick={() => void choose()}>{t('rework.knowledge.chooseVault')}</UiButton>{!isTauri() && <p className="text-xs leading-5 text-text-muted">{t('rework.knowledge.desktopOnly')}</p>}</div>}
      <UiField label={t('rework.knowledge.captureFolder')}><UiInput value={folder} disabled={busy || attempted} onChange={event => setFolder(event.target.value)} placeholder={t('rework.knowledge.captureRoot')} /></UiField>
      <ul className="ui-scrollbar max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--line)] p-3 text-xs text-text-muted">{snapshots.map((snapshot, index) => <li key={`${snapshot.title}:${index}`}>{snapshot.title} · {t('rework.knowledge.mediaCount', { count: snapshot.media.length })}</li>)}</ul>
      {remote && <p role="alert" className="text-xs leading-5 text-warning">{t('rework.knowledge.downloadFirst')}</p>}
      {paths.length > 0 && <div role="status" className="space-y-1 text-xs text-success"><p>{t('rework.knowledge.captured', { count: paths.length })}</p>{paths.map(path => <p key={path} className="break-words">{path}</p>)}</div>}
      {error && <p role="alert" className="break-words text-xs leading-5 text-danger">{error}</p>}
    </div>
  </UiModal>;
}
