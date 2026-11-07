import { useState } from 'react';
import { useStore, type ReactFlowState } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  BookmarkPlus,
  BookOpen,
  Boxes,
  ChevronDown,
  CopyPlus,
  Download,
  Group,
  LayoutGrid,
  Link,
  Clapperboard,
  MessageSquarePlus,
  MoreHorizontal,
  NotebookPen,
  Play,
  Tags,
  Trash2,
  Ungroup,
} from 'lucide-react';

import { MenuItem, MenuSurface, anchorBelow, Tooltip, UiModal, UiSelect, UiButton } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { collectDownloadableMedia, saveNodesToAssets } from '@/features/canvas/application/selectionAssets';
import { createSkillFromGroup, type SkillDraft } from '@/features/canvas/agent/application/userSkills';
import { SkillEditorDialog, skillErrorText } from '@/features/agents/ui/SkillDialogs';
import { downloadAssetSource } from '@/features/assets/ui/AssetMedia';
import { downloadAsset } from '@/features/assets/application/assetDownloads';
import { CANVAS_GENERATION_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  isEligibleTagGroupMember,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import { shortcutLabel } from '@/features/canvas/engine/shortcuts';
import { useCanvasStore } from '@/stores/canvasStore';
import { SaveGroupTemplateDialog } from '@/features/library/ui/SaveGroupTemplateDialog';
import { openKnowledgeCapture } from '@/features/knowledge/ui/KnowledgeCaptureDialog';

const GENERATION_TYPES = new Set<CanvasNodeType>(CANVAS_GENERATION_NODE_TYPES);
const TAG_GROUP_PADDING = 28;
const NODE_TITLE_CLEARANCE = 32;

interface SelectionFrame {
  count: number;
  /** Screen-space top-centre of the selection bounds, relative to the canvas root. */
  x: number;
  y: number;
  bounds: { x: number; y: number; width: number; height: number };
  singleGroup: boolean;
}

/** Recomputed on every flow change (pan/zoom/drag) but cheap, and equality-gated. */
function selectFrame(state: ReactFlowState): SelectionFrame | null {
  if (state.userSelectionActive) return null;
  let count = 0;
  let groupCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of state.nodeLookup.values()) {
    if (!node.selected) continue;
    count += 1;
    if (node.type === 'groupNode') groupCount += 1;
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured.width ?? 0;
    const height = node.measured.height ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  const singleGroup = count === 1 && groupCount === 1;
  if (count < 2 && !singleGroup) return null;
  const [tx, ty, zoom] = state.transform;
  return {
    count,
    x: Math.round(((minX + maxX) / 2) * zoom + tx),
    // Clear the title bar that floats above each card (flow units, so it scales with zoom).
    y: Math.round((minY - NODE_TITLE_CLEARANCE) * zoom + ty),
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    singleGroup,
  };
}

function sameFrame(a: SelectionFrame | null, b: SelectionFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.count === b.count && a.x === b.x && a.y === b.y && a.singleGroup === b.singleGroup
    && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

export function SelectionToolbar({ scheduleCanvasPersist }: { scheduleCanvasPersist: (delayMs?: number) => void }) {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const frame = useStore(selectFrame, sameFrame);
  const [arrangeAnchor, setArrangeAnchor] = useState<{ x: number; y: number } | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<{ x: number; y: number } | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [templateGroupId, setTemplateGroupId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [commandError, setCommandError] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  if (!frame) return <>{skillDraft && <SkillEditorDialog initial={skillDraft} onClose={() => setSkillDraft(null)} />}{templateGroupId && <SaveGroupTemplateDialog groupId={templateGroupId} onClose={() => setTemplateGroupId(null)} />}</>;

  // Read at render time: this component re-renders whenever the selection frame changes.
  const nodes: CanvasNode[] = useCanvasStore.getState().nodes.filter((node) => node.selected);
  const canGenerate = nodes.some((node) => GENERATION_TYPES.has(node.type));
  const tagMembers = nodes.filter(isEligibleTagGroupMember);

  const createTagGroup = () => {
    if (tagMembers.length < 2) return;
    const nodeId = `tag-group-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    void canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.tagGroup,
        nodeId,
        position: { x: frame.bounds.x - TAG_GROUP_PADDING, y: frame.bounds.y - TAG_GROUP_PADDING },
        dimensions: {
          width: Math.max(420, Math.min(1400, frame.bounds.width + TAG_GROUP_PADDING * 2)),
          height: Math.max(260, Math.min(1000, frame.bounds.height + TAG_GROUP_PADDING * 2)),
        },
        configuration: { displayName: t('node.menu.tagGroup'), memberNodeIds: tagMembers.map((node) => node.id) },
      },
    }, 'ui').then((result) => {
      if (!result.ok) return;
      useCanvasStore.getState().setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
    });
  };

  const report = (tone: 'ok' | 'error', text: string) => {
    setFeedback({ tone, text });
    window.setTimeout(() => setFeedback((current) => (current?.text === text ? null : current)), 2600);
  };
  const selectedIds = () => useCanvasStore.getState().nodes.filter((node) => node.selected).map((node) => node.id);
  const saveSelectionToAssets = async () => {
    try {
      const result = await saveNodesToAssets(selectedIds());
      report(result.assetIds.length ? 'ok' : 'error', result.assetIds.length
        ? t('rework.canvas.savedToAssets', { count: result.assetIds.length })
        : t('rework.canvas.saveToAssetsNothing'));
    } catch (error) { report('error', error instanceof Error ? error.message : String(error)); }
  };
  /** Visible members only: collapsed stack secondaries are skipped by collectDownloadableMedia. */
  const downloadSelection = async () => {
    const media = collectDownloadableMedia(selectedIds());
    if (!media.length) { report('error', t('rework.canvas.downloadNothing')); return; }
    try {
      for (const item of media) {
        if (item.kind === 'text') await downloadAsset({ id: item.nodeId, kind: 'text', source: item.source, name: item.fileStem });
        else await downloadAssetSource(item.source, item.fileStem);
      }
      report('ok', t('rework.canvas.downloaded', { count: media.length }));
    } catch (error) { report('error', error instanceof Error ? error.message : String(error)); }
  };
  const mergeStoryboard = async () => {
    const result = await canvasCommandRegistry.execute({ type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION, input: { nodeIds: selectedIds() } }, 'ui');
    if (!result.ok) { report('error', result.error.message); return; }
    scheduleCanvasPersist(0);
  };
  const connectSelection = async () => {
    const result = await canvasCommandRegistry.execute({ type: 'selection.connect', version: CANVAS_COMMAND_VERSION, input: { sourceNodeIds: selectedIds(), targetNodeId: targetId } }, 'ui');
    if (!result.ok) { setCommandError(result.error.message); return; }
    setConnecting(false); scheduleCanvasPersist(0);
  };
  const createSkill = () => {
    const group = nodes.find((node) => node.type === CANVAS_NODE_TYPES.group);
    if (!group) return;
    try {
      const { nodes: all, edges } = useCanvasStore.getState();
      setSkillDraft(createSkillFromGroup(group.id, all, edges));
    } catch (error) { report('error', skillErrorText(error)); }
  };

  return (
    <div
      className="canvas-chrome canvas-selection-bar"
      data-canvas-overlay=""
      style={{ left: frame.x, top: Math.max(56, frame.y - 10) }}
    >
      <span className="canvas-selection-bar__count">
        {t('rework.canvas.selected', { count: frame.singleGroup ? 1 : frame.count })}
      </span>
      {nodes.length >= 2 && <>
        <button type="button" className="canvas-action" onClick={() => void mergeStoryboard()}><Clapperboard />{t('ui.canvas.mergeStoryboard')}</button>
        <button type="button" className="canvas-action" onClick={() => { setConnecting(true); setCommandError(''); }}><Link />{t('ui.canvas.connectSelection')}</button>
      </>}
      {frame.singleGroup ? (
        <Tooltip label={t('rework.canvas.menu.ungroup')} shortcut={shortcutLabel('organize.ungroup')} side="top">
          <button type="button" className="canvas-action" onClick={actions.ungroupSelection}>
            <Ungroup />{t('rework.canvas.menu.ungroup')}
          </button>
        </Tooltip>
      ) : (
        <>
          <button
            type="button"
            className="canvas-action"
            aria-expanded={Boolean(arrangeAnchor)}
            onClick={(event) => {
              setArrangeAnchor(arrangeAnchor ? null : anchorBelow(event.currentTarget));
            }}
          >
            <LayoutGrid />{t('rework.canvas.selection.arrange')}<ChevronDown />
          </button>
          <Tooltip label={t('rework.canvas.menu.group')} shortcut={shortcutLabel('organize.group')} side="top">
            <button type="button" className="canvas-action" onClick={actions.groupSelection}>
              <Group />{t('rework.canvas.menu.group')}
            </button>
          </Tooltip>
          <Tooltip
            label={tagMembers.length < 2 ? t('canvas.batchToolbar.tagGroupUnavailable') : t('canvas.batchToolbar.tagGroup')}
            side="top"
          >
            <button type="button" className="canvas-action" disabled={tagMembers.length < 2} onClick={createTagGroup}>
              <Tags />{t('canvas.batchToolbar.tagGroup')}
            </button>
          </Tooltip>
        </>
      )}
      <Tooltip label={t('rework.canvas.menu.duplicate')} shortcut={shortcutLabel('edit.duplicate')} side="top">
        <button type="button" className="canvas-action canvas-action--icon" aria-label={t('rework.canvas.menu.duplicate')} onClick={actions.duplicateSelection}>
          <CopyPlus />
        </button>
      </Tooltip>
      {canGenerate ? (
        <Tooltip label={t('rework.canvas.selection.generateHint')} side="top">
          <button type="button" className="canvas-action" onClick={actions.generateSelection}>
            <Play />{t('rework.canvas.selection.generate')}
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={t('rework.more')} side="top">
        <button
          type="button"
          className="canvas-action canvas-action--icon"
          aria-label={t('rework.more')}
          aria-expanded={Boolean(moreAnchor)}
          onClick={(event) => {
            setMoreAnchor(moreAnchor ? null : anchorBelow(event.currentTarget));
          }}
        >
          <MoreHorizontal />
        </button>
      </Tooltip>
      <Tooltip label={t('common.delete')} shortcut={shortcutLabel('edit.delete')} side="top">
        <button type="button" className="canvas-action canvas-action--icon" data-tone="danger" aria-label={t('common.delete')} onClick={actions.deleteSelection}>
          <Trash2 />
        </button>
      </Tooltip>
      {arrangeAnchor ? (
        <MenuSurface anchor={arrangeAnchor} onClose={() => setArrangeAnchor(null)} width={200}>
          <MenuItem icon={<LayoutGrid />} label={t('rework.canvas.menu.arrangeGrid')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('grid'); }} />
          <MenuItem icon={<AlignHorizontalSpaceAround />} label={t('rework.canvas.selection.arrangeRow')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('horizontal'); }} />
          <MenuItem icon={<AlignVerticalSpaceAround />} label={t('rework.canvas.selection.arrangeColumn')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('vertical'); }} />
        </MenuSurface>
      ) : null}
      {moreAnchor ? (
        <MenuSurface anchor={moreAnchor} onClose={() => setMoreAnchor(null)} width={220}>
          <MenuItem icon={<BookmarkPlus />} label={t('rework.canvas.saveToAssets')} onClick={() => { setMoreAnchor(null); void saveSelectionToAssets(); }} />
          <MenuItem icon={<Download />} label={t('rework.canvas.downloadSelection')} onClick={() => { setMoreAnchor(null); void downloadSelection(); }} />
          <MenuItem icon={<MessageSquarePlus />} label={t('rework.canvas.addToChat')} onClick={() => { setMoreAnchor(null); canvasEventBus.publish('agent/attach-nodes', { nodeIds: selectedIds() }); }} />
          <MenuItem icon={<NotebookPen />} label={t('rework.knowledge.captureTitle')} onClick={() => { setMoreAnchor(null); openKnowledgeCapture(selectedIds()); }} />
          {frame.singleGroup ? (
            <>
              <MenuItem icon={<Boxes />} label={t('rework.toolbox.saveGroup')} onClick={() => { setMoreAnchor(null); setTemplateGroupId(nodes.find(node => node.type === CANVAS_NODE_TYPES.group)?.id ?? null); }} />
              <MenuItem icon={<BookOpen />} label={t('rework.canvas.createSkill')} onClick={() => { setMoreAnchor(null); createSkill(); }} />
            </>
          ) : null}
        </MenuSurface>
      ) : null}
      {feedback ? (
        <span role={feedback.tone === 'error' ? 'alert' : 'status'} className="canvas-selection-bar__feedback" data-tone={feedback.tone}>{feedback.text}</span>
      ) : null}
      {skillDraft ? <SkillEditorDialog initial={skillDraft} onClose={() => setSkillDraft(null)} /> : null}
      {templateGroupId && <SaveGroupTemplateDialog groupId={templateGroupId} onClose={() => setTemplateGroupId(null)} />}
      {connecting && <UiModal isOpen title={t('ui.canvas.connectSelection')} onClose={() => setConnecting(false)} footer={<UiButton variant="primary" disabled={!targetId} onClick={() => void connectSelection()}>{t('ui.canvas.connect')}</UiButton>}><UiSelect aria-label={t('ui.canvas.selectTarget')} value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">{t('ui.canvas.selectTarget')}</option>{useCanvasStore.getState().nodes.filter((node) => !node.selected).map((node) => <option key={node.id} value={node.id}>{String(node.data.displayName || node.id)}</option>)}</UiSelect>{commandError && <p role="alert" className="mt-3 text-sm text-danger">{commandError}</p>}</UiModal>}
    </div>
  );
}
