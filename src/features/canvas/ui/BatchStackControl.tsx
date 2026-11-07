import { useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, Rows3, Ungroup, Grid2X2 } from 'lucide-react';
import { PopoverSurface, UiButton, anchorAbove, type MenuAnchor } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { openMediaViewer } from '@/features/viewer/viewerStore';
import { useTranslation } from 'react-i18next';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { selectBatchStack } from '@/features/canvas/application/stacks';
import { useCanvasStore } from '@/stores/canvasStore';

interface Props {
  nodeId: string;
  batchId: string;
  index: number;
  total: number;
  collapsed: boolean;
  selected: boolean;
}

/**
 * Multi-result stack chip. Static data drives the badge; the stack itself is read only on click so a
 * 1000-node canvas never scans members per render. Each action is one undo step in the store.
 */
export function BatchStackControl({ nodeId, batchId, index, total, collapsed, selected }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const members = anchor ? selectBatchStack(useCanvasStore.getState().nodes, batchId).memberIds.flatMap((id) => {
    const node = useCanvasStore.getState().nodes.find((entry) => entry.id === id);
    if (!node) return [];
    const kind = node.type === CANVAS_NODE_TYPES.video ? 'video' as const : node.type === CANVAS_NODE_TYPES.audio ? 'audio' as const : 'image' as const;
    const source = kind === 'video' ? node.data.localVideoUrl || node.data.videoUrl : kind === 'audio' ? node.data.localAudioUrl || node.data.audioUrl : node.data.imageUrl;
    return typeof source === 'string' && source ? [{ id, kind, source }] : [];
  }) : [];
  const step = (delta: number) => {
    const store = useCanvasStore.getState();
    const stack = selectBatchStack(store.nodes, batchId);
    const current = stack.memberIds.indexOf(nodeId);
    if (current < 0 || stack.memberIds.length < 2) return;
    const next = stack.memberIds[(current + delta + stack.memberIds.length) % stack.memberIds.length];
    // Collapsed: the visible face changes to `next`; expanded: just move selection along the batch.
    if (stack.collapsed) store.setBatchPrimary(batchId, next);
    store.setSelectedNode(next);
  };
  const toggle = () => {
    const store = useCanvasStore.getState();
    const commands: CanvasCommand[] = [{ type: 'batch.setCollapsed', version: CANVAS_COMMAND_VERSION, input: { batchId, collapsed: !collapsed } }];
    if (!collapsed) commands.push({ type: 'batch.setPrimary', version: CANVAS_COMMAND_VERSION, input: { batchId, nodeId } });
    const result = canvasCommandRegistry.executeTransaction({ id: crypto.randomUUID(), origin: 'ui', expectedRevision: store.revision, commands });
    if (!result.ok) void showErrorDialog(result.error.message, t('common.error'));
  };
  return (
    <><span className="node-frame__badge node-stack" data-collapsed={collapsed || undefined}>
      {collapsed ? <Layers aria-hidden="true" /> : null}
      {index}/{total}
      {selected ? (
        <span className="node-stack__actions nodrag">
          <button type="button" aria-label={t('rework.canvas.stack.previous')} title={t('rework.canvas.stack.previous')} onClick={() => step(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" aria-label={t('rework.canvas.stack.next')} title={t('rework.canvas.stack.next')} onClick={() => step(1)}>
            <ChevronRight />
          </button>
          <button
            type="button"
            aria-label={t(collapsed ? 'rework.canvas.stack.expand' : 'rework.canvas.stack.collapse')}
            title={t(collapsed ? 'rework.canvas.stack.expand' : 'rework.canvas.stack.collapse')}
            onClick={toggle}
          >
            {collapsed ? <Rows3 /> : <Layers />}
          </button>
          <button type="button" title={t('ui.canvas.batchResults')} aria-label={t('ui.canvas.batchResults')} onClick={(event) => setAnchor(anchor ? null : anchorAbove(event.currentTarget))}><Grid2X2 /></button>
          <button type="button" title={t('ui.canvas.splitBatch')} aria-label={t('ui.canvas.splitBatch')} onClick={() => void canvasCommandRegistry.execute({ type: 'batch.split', version: CANVAS_COMMAND_VERSION, input: { batchId } }, 'ui').then((result) => { if (!result.ok) void showErrorDialog(result.error.message, t('common.error')); })}><Ungroup /></button>
        </span>
      ) : null}
    </span>
    {anchor && <PopoverSurface anchor={anchor} width={360} label={t('ui.canvas.batchResults')} onClose={() => setAnchor(null)} className="p-3">
      <p className="mb-3 text-xs text-text-muted">{t('ui.canvas.chooseBatchPrimary')}</p>
      <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">{members.map((member,index) => <button type="button" key={member.id} className="overflow-hidden rounded-lg border border-line text-left" aria-pressed={member.id===nodeId} onClick={() => { useCanvasStore.getState().setBatchPrimary(batchId,member.id); useCanvasStore.getState().setSelectedNode(member.id); setAnchor(null); }}><AssetMedia kind={member.kind} source={member.source} className="aspect-square w-full object-cover" /><span className="block p-1.5 text-xs">{index+1}</span></button>)}</div>
      <UiButton variant="secondary" className="mt-3 w-full" onClick={() => { openMediaViewer(members.map((member,index) => ({ ...member,title:`${t('ui.canvas.batchResults')} ${index+1}` })),Math.max(0,members.findIndex((member)=>member.id===nodeId))); setAnchor(null); }}>{t('ui.canvas.openBatchViewer')}</UiButton>
    </PopoverSurface>}</>
  );
}
