import { useState } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { Play, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiField, UiInput, UiModal, UiTextArea } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { getCanvasHistoryReuseOptions, type CanvasHistoryReuseOptions } from '@/features/library/application/projectLibraryActions';
import { submitNodeGeneration } from '../application/generation';

const useDraftOptionsEditor = create<{ nodeId: string | null }>(() => ({ nodeId: null }));
export function openGenerationDraftOptionsEditor(nodeId: string): void { useDraftOptionsEditor.setState({ nodeId }); }
export function GenerationDraftOptionsDialogHost() {
  const nodeId = useDraftOptionsEditor(state => state.nodeId);
  if (!nodeId) return null;
  return <GenerationDraftOptionsDialog key={nodeId} nodeId={nodeId} onClose={() => useDraftOptionsEditor.setState({ nodeId: null })} />;
}
const toolParamsSchema = z.record(z.string(), z.unknown());

function GenerationDraftOptionsDialog({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const { t } = useTranslation();
  const node = useCanvasStore(state => state.nodes.find(item => item.id === nodeId));
  const initial = node ? getCanvasHistoryReuseOptions(node.data) : null;
  const [count, setCount] = useState(String(initial?.count ?? 1));
  const [useTool, setUseTool] = useState(Boolean(initial?.tool));
  const [prompt, setPrompt] = useState(initial?.tool?.prompt ?? '');
  const [params, setParams] = useState(JSON.stringify(initial?.tool?.params ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const save = (clear = false): CanvasHistoryReuseOptions | null => {
    try {
      const store = useCanvasStore.getState();
      const live = store.nodes.find(item => item.id === nodeId);
      if (!live) throw new Error(t('rework.generationHistory.sourceMissing'));
      const options: CanvasHistoryReuseOptions = {};
      if (!clear) {
        options.count = Number(count);
        if (useTool && initial?.tool) {
          const values = toolParamsSchema.parse(JSON.parse(params));
          options.tool = { id: initial.tool.id, prompt, params: values };
        }
        if (!getCanvasHistoryReuseOptions({ ...live.data, historyReuseOptions: options })) throw new Error(t('rework.generationHistory.invalidToolParams'));
      }
      const data = { ...live.data };
      if (clear) delete data.historyReuseOptions; else data.historyReuseOptions = options;
      const revision = store.commitGraphTransaction({ expectedRevision: store.revision, nodes: store.nodes.map(item => item.id === nodeId ? { ...item, data } : item), edges: store.edges, selectedNodeId: store.selectedNodeId });
      if (revision === null) throw new Error(t('rework.toolbox.errors.revision-conflict'));
      const next = useCanvasStore.getState();
      useProjectStore.getState().saveCurrentProject(next.nodes, next.edges, next.currentViewport, next.history);
      setError(''); setNotice(t('rework.generationHistory.optionsSaved'));
      return options;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
  };
  const generate = async () => {
    if (busy) return;
    const options = save();
    if (!options) return;
    setBusy(true); setNotice('');
    try {
      const outcome = await submitNodeGeneration(nodeId, options);
      if (!outcome.ok) setError(outcome.message);
      else setNotice(t('rework.generationHistory.generationSubmitted'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <UiModal isOpen title={t('rework.generationHistory.restoredOptions')} onClose={() => { if (!busy) onClose(); }} widthClassName="w-[min(680px,calc(100vw-1.5rem))]"
    footer={<><UiButton variant="ghost" disabled={busy} onClick={() => { if (save(true)) onClose(); }}>{t('rework.generationHistory.clearOptions')}</UiButton><UiButton icon={<Save />} disabled={busy} onClick={() => save()}>{t('common.save')}</UiButton><UiButton variant="primary" icon={<Play />} loading={busy} disabled={!node} onClick={() => void generate()}>{t('rework.generationHistory.generateWithOptions')}</UiButton></>}>
    <div className="space-y-4"><p className="text-xs leading-6 text-text-muted">{t('rework.generationHistory.optionsHint')}</p><UiField label={t('rework.generationHistory.count')}><UiInput type="number" min={1} step={1} value={count} disabled={busy} onChange={event => setCount(event.target.value)} /></UiField>
      {initial?.tool && <><label className="flex items-center gap-2 text-sm text-text-dark"><UiCheckbox checked={useTool} disabled={busy} onCheckedChange={setUseTool} />{t('rework.generationHistory.useOriginalTool', { name: initial.tool.id })}</label>{useTool && <><UiField label={t('rework.materialLibrary.prompt')}><UiTextArea value={prompt} disabled={busy} rows={4} onChange={event => setPrompt(event.target.value)} /></UiField><UiField label={t('rework.generationHistory.toolParams')}><UiTextArea value={params} disabled={busy} rows={6} onChange={event => setParams(event.target.value)} className="font-mono text-xs" /></UiField></>}</>}
      {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-success">{notice}</p>}
    </div>
  </UiModal>;
}
