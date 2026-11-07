import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Crop, FlipHorizontal2, FlipVertical2, Pencil, Redo2, RotateCw, Undo2 } from 'lucide-react';
import { UiButton, UiField, UiInput, UiModal, UiSegmented, UiTextArea, UiConfirm } from '@/components/ui';
import type { AssetRecord } from '../application/assetCatalog';
import { editAssetMedia, saveDerivedAsset, type AssetEditDetails, type AssetEditOutput } from '../application/assetEditing';
import { persistAssetBlob, getAssetPortableSource, getAssetDisplaySource } from '../application/assetMediaStorage';
import { useAssetDisplaySource } from './useAssetDisplaySource';
import { MediaEditDialog } from '@/features/canvas/ui/MediaEditDialog';
import { CropToolEditor } from '@/features/canvas/ui/tool-editors/CropToolEditor';
import { cropToolPlugin, annotateToolPlugin } from '@/features/canvas/tools/builtInTools';
import type { ToolOptions } from '@/features/canvas/tools';
import { canvasToolProcessor } from '@/features/canvas/application/canvasServices';
import { processMediaEdit, type MediaEditOperation } from '@/features/canvas/application/media';
import { loadImageElement } from '@/features/canvas/application/imageData';
import { parseAnnotationItems } from '@/features/canvas/tools/annotation';

// Match NodeToolDialog's bundle boundary: Konva is loaded only when annotation
// is opened, not by every canvas node action or the asset-library first paint.
const AnnotateToolEditor = lazy(() => import('@/features/canvas/ui/tool-editors/AnnotateToolEditor').then((module) => ({ default: module.AnnotateToolEditor })));

interface Props {
  asset: AssetRecord; onClose(): void; onSaved?(assets: AssetRecord[]): Promise<void> | void;
  save?(output: AssetEditOutput, details: AssetEditDetails): Promise<AssetRecord>;
}
export function AssetEditDialog(props: Props) {
  const { asset, onClose, onSaved } = props;
  const mediaSaveId = useRef(crypto.randomUUID());
  if (asset.kind === 'video' || asset.kind === 'audio') return <MediaEditDialog source={asset.source} media={asset.kind} onClose={onClose}
    onApply={async (operation, options) => { const assets = await editAssetMedia(asset, operation, options, mediaSaveId.current); await onSaved?.(assets); onClose(); return { count: assets.length }; }} />;
  return <ImageOrTextEditor key={asset.id} {...props} />;
}

function ImageOrTextEditor({ asset, onClose, onSaved, save }: Props) {
  const [name, setName] = useState(`${asset.name} · 编辑`);
  const [prompt, setPrompt] = useState(typeof asset.metadata.prompt === 'string' ? asset.metadata.prompt : typeof asset.metadata.sourcePrompt === 'string' ? asset.metadata.sourcePrompt : '');
  const [text, setText] = useState(asset.kind === 'text' ? asset.source : '');
  const [tool, setTool] = useState<'crop' | 'annotate'>('crop');
  const [options, setOptions] = useState<ToolOptions>({ aspectRatio: 'free' });
  const [steps, setSteps] = useState([{ source: asset.source, label: '原图' }]); const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [discard, setDiscard] = useState(false);
  const lock = useRef(false); const alive = useRef(true); const controller = useRef<AbortController | null>(null);
  const savedResult = useRef<AssetRecord | null>(null); const saveId = useRef(crypto.randomUUID());
  const source = steps[at].source; const display = useAssetDisplaySource(source);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const resetOptions = (next: typeof tool) => setOptions(next === 'crop' ? { aspectRatio: 'free' } : { annotations: '[]', color: '#ff4d4f', lineWidthPercent: 0.4, fontSizePercent: 10 });
  const pendingEdit = () => (tool === 'crop' && typeof options.cropWidth === 'number' && options.cropWidth > 0)
    || (tool === 'annotate' && parseAnnotationItems(options.annotations).length > 0);
  const changeTool = async (next: typeof tool) => {
    if (next === tool || lock.current) return;
    if (pendingEdit() && !await apply()) return;
    setTool(next); resetOptions(next);
  };
  const apply = async (operation?: Extract<MediaEditOperation, { kind: 'image.transform' }>) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(''); const abort = new AbortController(); controller.current = abort;
    try {
      let next: string;
      if (operation) {
        let base = source;
        if (pendingEdit()) {
          const result = await canvasToolProcessor.process(tool, await getAssetPortableSource(source), options);
          if (!result.outputImageUrl) throw new Error('编辑没有产生图片。');
          base = result.outputImageUrl;
        }
        next = await persistAssetBlob((await processMediaEdit(base, operation, { signal: abort.signal })).outputs[0].blob);
      }
      else {
        const result = await canvasToolProcessor.process(tool, await getAssetPortableSource(source), options);
        if (!result.outputImageUrl) throw new Error('编辑没有产生图片。');
        next = result.outputImageUrl;
      }
      if (!alive.current || abort.signal.aborted) return false;
      const nextSteps = [...steps.slice(0, at + 1), { source: next, label: operation ? operation.rotate ? '旋转' : operation.flipX ? '水平翻转' : '垂直翻转' : tool === 'crop' ? '裁剪' : '标注' }].slice(-20);
      setSteps(nextSteps); setAt(nextSteps.length - 1); resetOptions(tool);
      return true;
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const saveResult = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!savedResult.current) {
        const operations = asset.kind === 'text' ? ['text.edit'] : steps.slice(1, at + 1).map((entry) => entry.label);
        let finalSource = asset.kind === 'text' ? text : source;
        if (asset.kind === 'image' && ((tool === 'crop' && typeof options.cropWidth === 'number' && options.cropWidth > 0)
          || (tool === 'annotate' && parseAnnotationItems(options.annotations).length))) {
          const result = await canvasToolProcessor.process(tool, await getAssetPortableSource(source), options);
          if (!result.outputImageUrl) throw new Error('编辑没有产生图片。');
          finalSource = result.outputImageUrl; operations.push(tool === 'crop' ? '裁剪' : '标注');
        }
        const output: AssetEditOutput = { kind: asset.kind, source: finalSource };
        if (asset.kind === 'image') {
          const image = await loadImageElement(await getAssetDisplaySource(finalSource));
          output.width = image.naturalWidth; output.height = image.naturalHeight; image.src = '';
        }
        if (!alive.current) return;
        const details = { name, prompt, operations };
        savedResult.current = save ? await save(output, details) : await saveDerivedAsset(asset, output, details, { id: saveId.current });
      }
      await onSaved?.([savedResult.current]); onClose();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const requestClose = () => { if (!busy) setDiscard(true); };
  return <><UiModal isOpen title={asset.kind === 'image' ? '编辑图片' : '编辑文本'} onClose={requestClose} widthClassName="w-[min(1060px,calc(100vw-2rem))]"
    footer={<><span className="mr-auto self-center text-xs text-text-muted">保存为新素材，原件保留</span><UiButton disabled={busy} onClick={requestClose}>取消</UiButton><UiButton variant="primary" loading={busy} disabled={!name.trim() || (asset.kind === 'text' && !text.trim()) || (asset.kind === 'image' && !display.url)} onClick={() => void saveResult()}>保存编辑副本</UiButton></>}>
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2"><UiField label="副本名称"><UiInput value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></UiField>
        <UiField label="素材提示词 / 说明"><UiTextArea rows={2} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} /></UiField></div>
      {asset.kind === 'text' ? <UiField label="文本内容"><UiTextArea rows={15} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></UiField> : <>
        <div className="flex flex-wrap items-center gap-2"><UiSegmented value={tool} onChange={(next) => void changeTool(next)} options={[{ value: 'crop', label: '裁剪', icon: <Crop /> }, { value: 'annotate', label: '标注', icon: <Pencil /> }]} />
          <UiButton size="sm" disabled={busy} icon={<RotateCw />} onClick={() => void apply({ kind: 'image.transform', rotate: 90 })}>旋转 90°</UiButton>
          <UiButton size="sm" disabled={busy} icon={<FlipHorizontal2 />} onClick={() => void apply({ kind: 'image.transform', rotate: 0, flipX: true })}>水平翻转</UiButton>
          <UiButton size="sm" disabled={busy} icon={<FlipVertical2 />} onClick={() => void apply({ kind: 'image.transform', rotate: 0, flipY: true })}>垂直翻转</UiButton>
          <UiButton size="sm" disabled={busy || at === 0} aria-label="撤销图片编辑" icon={<Undo2 />} onClick={() => { setAt(at - 1); resetOptions(tool); }} />
          <UiButton size="sm" disabled={busy || at === steps.length - 1} aria-label="重做图片编辑" icon={<Redo2 />} onClick={() => { setAt(at + 1); resetOptions(tool); }} />
        </div>
        <p className="text-xs text-text-muted">可直接保存当前编辑；要继续其他工具，先点“应用{tool === 'crop' ? '裁剪' : '标注'}”。当前步骤：{steps[at].label}</p>
        {display.url && <fieldset disabled={busy} className={busy ? 'pointer-events-none opacity-60' : ''}>{tool === 'crop'
          ? <CropToolEditor key={`${at}:${source}`} plugin={cropToolPlugin} sourceImageUrl={display.url} options={options} onOptionsChange={setOptions} />
          : <Suspense fallback={<p role="status">正在加载标注工具…</p>}><AnnotateToolEditor key={`${at}:${source}`} plugin={annotateToolPlugin} sourceImageUrl={display.url} options={options} onOptionsChange={setOptions} /></Suspense>}</fieldset>}
        {!display.url && !display.error && <p role="status">正在读取原图…</p>}
        <div className="flex justify-end"><UiButton disabled={busy || !display.url} onClick={() => void apply()}>应用{tool === 'crop' ? '裁剪' : '标注'}</UiButton></div>
      </>}
      {(error || display.error) && <p role="alert" className="text-xs text-danger">{error || display.error}</p>}
    </div>
  </UiModal><UiConfirm isOpen={discard} title="关闭编辑？" description="尚未保存的编辑会被丢弃，原素材不受影响。" confirmLabel="放弃编辑" onConfirm={onClose} onClose={() => setDiscard(false)} /></>;
}
