import { useMemo, useState, type ReactNode } from 'react';
import { Position } from '@xyflow/react';
import { ArrowUp, AtSign, Bookmark, FileText, ImagePlus, Music, Slash, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, UiButton, UiModal } from '@/components/ui';
import {
  submitNodeGeneration,
  type GenerationRequestOptions,
  type GenerationSubmitOutcome,
} from '@/features/canvas/application/generation';
import { formatChord } from '@/features/canvas/engine/shortcuts';
import { SafeNodeToolbar } from '@/features/canvas/ui/SafeNodeToolbar';
import { PromptEditor, type PastedImageResolver, type SlashCommand } from './PromptEditor';
import { useNodeReferences, type ComposerReference } from './useNodeReferences';
import type { PromptDraft } from './usePromptDraft';
import { useCanvasStore } from '@/stores/canvasStore';
import { getCanvasHistoryReuseOptions } from '@/features/library/application/projectLibraryActions';
import { openGenerationDraftOptionsEditor } from '@/features/canvas/ui/GenerationDraftOptionsDialog';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { openCanvasAssetEditor } from '@/features/assets/ui/CanvasAssetEditHost';
import { ComposerPromptPicker } from './ComposerPromptPicker';
import { applyComposerPrompt, useSourceCommands, type ComposerPromptOption } from './useSourceCommands';
import { planNodeReferenceRemoval, referenceIdentityKey, type ReferenceIdentity, type ReferencePromptTarget } from '@/features/canvas/application/removeNodeReference';

interface NodeComposerProps {
  nodeId: string;
  /** Shown while the node is the sole selection. */
  open: boolean;
  draft: PromptDraft;
  /** Explicit persisted text location for a composer editing a storyboard shot. */
  referencePromptTarget?: ReferencePromptTarget;
  placeholder: string;
  slashCommands?: readonly SlashCommand[];
  sourceChip?: { label: string; onClear(): void } | null;
  onPasteImage?: (file: File) => Promise<string | null>;
  resolvePastedImage?: PastedImageResolver;
  /** Model, ratio, count… for this node kind. */
  params: ReactNode;
  /** Essential actions stay outside the shrinking model/parameter area. */
  trailingActions?: ReactNode;
  /** Read at submit time, so it always reflects the latest params. */
  requestOptions?: () => GenerationRequestOptions;
  generateLabel?: string;
  /** Disable generation with a reason (no model, missing input…). */
  blockedReason?: string | null;
  /** References the current model can take; others stay connected but aren't offered. */
  acceptsReference?: (reference: ComposerReference) => boolean;
}

/**
 * The floating generator under a selected node — one component for image, video, audio and
 * text. Screen-constant size, docks to the viewport bottom when the node is low, and the top
 * toolbar yields to it. Generation goes through the canvas generation service, the same path
 * the Agent and batch run use.
 */
export function NodeComposer(props: NodeComposerProps) {
  // Hidden composers do not need graph-reference or React Flow subscriptions.
  // Prompt and parameter drafts remain owned by the node, so deselection does not discard them.
  return props.open ? <ActiveNodeComposer {...props} /> : null;
}

function ActiveNodeComposer({
  nodeId,
  open,
  draft,
  referencePromptTarget,
  placeholder,
  slashCommands,
  sourceChip,
  onPasteImage,
  resolvePastedImage,
  params,
  trailingActions,
  requestOptions,
  generateLabel,
  blockedReason,
  acceptsReference,
}: NodeComposerProps) {
  const { t } = useTranslation();
  const node = useCanvasStore(state => state.nodes.find(node => node.id === nodeId));
  const nodeData = node?.data;
  const restored = nodeData ? getCanvasHistoryReuseOptions(nodeData) : null;
  const upstream = useNodeReferences(nodeId);
  const references = useMemo(() => acceptsReference
    ? { all: upstream.all.filter(acceptsReference), pickable: upstream.pickable.filter(acceptsReference) }
    : upstream, [acceptsReference, upstream]);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerGroup, setPickerGroup] = useState<'preset' | 'image' | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [slashRequest, setSlashRequest] = useState(0);
  const [referenceRequest, setReferenceRequest] = useState(0);
  const [pendingRemoval, setPendingRemoval] = useState<{ reference: ReferenceIdentity; count: number; signature: string; draftKey?: string } | null>(null);
  const supportsImageFunctions = node?.type === CANVAS_NODE_TYPES.imageEdit;
  const promptOptions = useSourceCommands(supportsImageFunctions);
  const images = references.all.filter(reference => reference.kind === 'image' && reference.imageUrl);
  const applyOption = (option: ComposerPromptOption, replace = false, reference?: ComposerReference) => {
    const text = reference ? `${t('ui.canvas.referencePromptTarget', { token: reference.token })}\n\n${option.prompt}` : option.prompt;
    applyComposerPrompt(draft, text, replace);
    setNotice(t('ui.canvas.promptApplied'));
  };
  const legacyOption = promptOptions.find(option => option.id === `preset:${nodeData?.selectedPromptPresetId}`
    || option.id === `function:${nodeData?.selectedFunctionChip}`);
  const editReference = (reference: ComposerReference) => {
    try { openCanvasAssetEditor(reference.sourceNodeId); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const commands: SlashCommand[] = [
    { id: 'browse-presets', label: t('ui.canvas.promptPresets'), hint: t('ui.canvas.promptChoicesHint'), icon: <Bookmark />, focusEditor: false, run: () => setPickerGroup('preset') },
    { id: 'reference', label: t('rework.references'), hint: t('ui.canvas.referenceCommandHint'), icon: <AtSign />, focusEditor: false, run: () => setReferenceRequest(value => value + 1) },
    ...(supportsImageFunctions ? [{ id: 'browse-image-tools', label: t('ui.canvas.imageFunctions'), icon: <ImagePlus />, focusEditor: false, run: () => setPickerGroup('image') }] : []),
    ...promptOptions.filter(option => option.group !== 'image' || images.length > 0).map(option => ({
      id: option.id, label: option.label, hint: option.hint ?? option.prompt, icon: option.group === 'image' ? <ImagePlus /> : <Bookmark />, focusEditor: option.group !== 'image' || images.length === 1,
      run: () => { if (option.group === 'image' && images.length !== 1) { setPickerSearch(option.label); setPickerGroup('image'); } else applyOption(option, false, option.group === 'image' ? images[0] : undefined); },
    })),
    ...(slashCommands ?? []),
  ];

  const generate = async () => {
    if (submitting || blockedReason) {
      if (blockedReason) setNotice(blockedReason);
      return;
    }
    draft.flush();
    setSubmitting(true);
    setNotice(null);
    let outcome: GenerationSubmitOutcome;
    try {
      const live = useCanvasStore.getState().nodes.find(node => node.id === nodeId);
      const defaults = live ? getCanvasHistoryReuseOptions(live.data) : null;
      outcome = await submitNodeGeneration(nodeId, { ...(defaults ?? {}), ...(requestOptions?.() ?? {}) });
    } finally {
      setSubmitting(false);
    }
    // Upstream failures surface on the result node; only input problems are explained here.
    if (!outcome.ok && outcome.reason !== 'failed') setNotice(outcome.message);
  };

  const insertReference = (reference: ComposerReference) => {
    const text = draft.read();
    const spacer = text && !/\s$/.test(text) ? ' ' : '';
    draft.flush(`${text}${spacer}${reference.token} `);
  };

  const removeReference = (reference: ReferenceIdentity, confirmedSignature?: string) => {
    if (confirmedSignature !== undefined && pendingRemoval?.draftKey !== draft.key) {
      setPendingRemoval(null); setNotice(t('ui.canvas.referenceRemovalChanged')); return;
    }
    const graph = useCanvasStore.getState();
    const plan = planNodeReferenceRemoval({ nodeId, reference, nodes: graph.nodes, edges: graph.edges, prompt: draft.read(), promptTarget: referencePromptTarget });
    if (!plan) { setPendingRemoval(null); setNotice(t('ui.canvas.referenceRemovalChanged')); return; }
    const signature = JSON.stringify([plan.edgeIds.slice().sort(), plan.removed.map(referenceIdentityKey).sort()]);
    if (confirmedSignature !== undefined && confirmedSignature !== signature) {
      setPendingRemoval(null); setNotice(t('ui.canvas.referenceRemovalChanged')); return;
    }
    if (plan.removed.length > 1 && confirmedSignature === undefined) {
      setPendingRemoval({ reference, count: plan.removed.length, signature, draftKey: draft.key }); return;
    }
    const committed = graph.commitGraphTransaction({ expectedRevision: graph.revision, nodes: plan.nodes, edges: plan.edges, selectedNodeId: graph.selectedNodeId });
    if (committed === null) { setNotice(t('ui.canvas.referenceRemovalChanged')); return; }
    // Adopt the already persisted text without invoking a frame writer that rebuilds its
    // array. Custom drafts can keep the older flush contract as a fallback.
    if (draft.acceptCommitted) draft.acceptCommitted(plan.prompt);
    else draft.flush(plan.prompt);
    setPendingRemoval(null);
    setNotice(t('ui.canvas.referenceRemoved', { count: plan.removed.length }));
  };

  return (
    <SafeNodeToolbar nodeId={nodeId} position={Position.Bottom} isVisible={open} offset={16} isComposer>
      <div
        className="node-composer"
        onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="node-composer__actions">
          <button type="button" onClick={() => setPickerGroup('preset')}><Bookmark />{t('ui.canvas.promptPresets')}</button>
          {supportsImageFunctions && <button type="button" onClick={() => setPickerGroup('image')}><ImagePlus />{t('ui.canvas.imageFunctions')}{images.length > 0 && <span className="text-text-subtle">{images.length}</span>}</button>}
          <button type="button" className="ml-auto" aria-label={t('rework.canvas.composer.functions')} onClick={() => setSlashRequest(value => value + 1)}><Slash /><span>{t('ui.canvas.slashHint')}</span></button>
        </div>
        {references.all.length > 0 ? (
          <div className="node-composer__refs" aria-label={t('rework.canvas.composer.references')}>
            {references.all.map((reference) => (
              <span key={referenceIdentityKey(reference)} className="node-composer__ref-tile">
                <Tooltip label={reference.title || reference.label} side="top">
                <button
                  type="button"
                  className="node-composer__ref"
                  onClick={() => insertReference(reference)}
                  aria-label={t('rework.canvas.composer.insertReference', { label: reference.label })}
                >
                  {reference.displayUrl ? (
                    <AssetMedia source={reference.displayUrl} kind="image" className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <span className="node-composer__ref-icon">
                      {reference.kind === 'video' ? <Video /> : reference.kind === 'audio' ? <Music /> : <FileText />}
                    </span>
                  )}
                  <span className="node-composer__ref-label">{reference.label}</span>
                </button>
                </Tooltip>
                <button type="button" className="node-composer__ref-remove"
                  aria-label={t('ui.canvas.removeReference', { label: reference.label })}
                  title={t('ui.canvas.removeReference', { label: reference.label })}
                  onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
                  onClick={event => { event.stopPropagation(); removeReference(reference); }}><X /></button>
              </span>
            ))}
          </div>
        ) : null}
        {restored && <button type="button" className="ui-chip mb-2 text-[11px]" onClick={() => openGenerationDraftOptionsEditor(nodeId)}>
          {t('rework.generationHistory.restoredOptions')}{restored.tool ? ` · ${restored.tool.id}` : ''}
        </button>}
        {legacyOption && <button type="button" className="ui-chip self-start text-xs" onClick={() => applyOption(legacyOption)}>{legacyOption.label} · {t('ui.canvas.loadLegacyPrompt')}</button>}
        <PromptEditor
          draft={draft}
          references={references.all}
          pickable={references.pickable}
          slashCommands={commands}
          slashPickerRequest={slashRequest}
          referencePickerRequest={referenceRequest}
          sourceChip={sourceChip}
          placeholder={placeholder}
          onSubmit={() => void generate()}
          onPasteImage={onPasteImage}
          resolvePastedImage={resolvePastedImage}
        />
        {pickerGroup && <ComposerPromptPicker key={`${draft.key}:${pickerGroup}`} options={promptOptions} initialGroup={pickerGroup} initialSearch={pickerSearch} images={images}
          onApply={applyOption} onEditImage={editReference} onClose={() => { setPickerGroup(null); setPickerSearch(''); }} />}
        <UiModal isOpen={pendingRemoval !== null} title={t('ui.canvas.removeSharedReferenceTitle')}
          description={t('ui.canvas.removeSharedReferenceHint', { count: pendingRemoval?.count ?? 0 })} onClose={() => setPendingRemoval(null)}
          footer={<><UiButton variant="secondary" onClick={() => setPendingRemoval(null)}>{t('common.cancel')}</UiButton>
            <UiButton variant="destructive" onClick={() => { if (pendingRemoval) removeReference(pendingRemoval.reference, pendingRemoval.signature); }}>{t('ui.canvas.disconnectReferences')}</UiButton></>}>{null}</UiModal>
        {notice ? <p className="node-composer__notice" role="status">{notice}</p> : null}
        <div className="node-composer__bar">
          <div className="node-composer__params">{params}</div>
          {trailingActions && <div className="node-composer__trailing-actions">{trailingActions}</div>}
          <Tooltip label={generateLabel ?? t('canvas.generate')} shortcut={formatChord('mod+enter')} side="top">
            <button
              type="button"
              className="node-composer__send"
              aria-label={generateLabel ?? t('canvas.generate')}
              data-busy={submitting || undefined}
              disabled={submitting}
              onClick={() => void generate()}
            >
              {submitting ? <span className="ui-spinner" /> : <ArrowUp strokeWidth={2.4} />}
            </button>
          </Tooltip>
        </div>
      </div>
    </SafeNodeToolbar>
  );
}
