import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import type { CanvasPlacementViewport } from '@/features/canvas/application/canvasNodePlacement';
import { planOrganizeCanvas } from '@/features/canvas/application/organizeCanvas';
import type { CanvasClipboardApi } from '@/features/canvas/clipboard/useCanvasClipboard';
import { CANVAS_GENERATION_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import { CANVAS_COMMAND_VERSION, type CanvasCommand, type CanvasNodeCreateConfiguration } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { getSelectedNodeIds } from '@/features/canvas/domain/canvasSelection';
import { useCanvasUiStore, type FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { createCanvasNode } from './nodeCreation';

const GENERATION_TYPES = new Set<CanvasNodeType>(CANVAS_GENERATION_NODE_TYPES);
const FIT_OPTIONS = { padding: 0.18, duration: 280, maxZoom: 1.2 } as const;
/** Screen pixels covered by floating chrome; matches canvas.css rail/controls geometry. */
const CHROME_INSET = { left: 68, right: 16, top: 64, bottom: 64 } as const;

/**
 * Every canvas-level verb in one place, shared by the rail, controls, menus, palette and
 * hotkeys so a shortcut and its button can never behave differently.
 */
export interface CanvasActions {
  zoomIn(): void;
  zoomOut(): void;
  zoomTo(zoom: number): void;
  fitView(): void;
  focusNodes(nodeIds: string[]): void;
  undo(): void;
  redo(): void;
  selectAll(): void;
  clearSelection(): void;
  copySelection(): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  groupSelection(): void;
  ungroupSelection(): void;
  connectSelection(): void;
  generateSelection(): void;
  layoutSelection(direction: 'grid' | 'horizontal' | 'vertical'): void;
  organizeCanvas(): void;
  /** Flow point at the centre of the visible canvas. */
  viewportCenter(): FlowPoint;
  createNode(type: CanvasNodeType, position?: FlowPoint, configuration?: CanvasNodeCreateConfiguration): string | null;
  /** Open the add-node menu at a client point (defaults to the viewport centre). */
  openAddMenu(client?: FlowPoint | null): void;
  clipboard: CanvasClipboardApi;
}

const CanvasActionsContext = createContext<CanvasActions | null>(null);

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext);
  if (!actions) throw new Error('useCanvasActions must be used inside <CanvasActionsProvider>');
  return actions;
}

function selectedNodes(): CanvasNode[] {
  return useCanvasStore.getState().nodes.filter((node) => node.selected);
}

function run(command: CanvasCommand, persist: (delayMs?: number) => void) {
  void canvasCommandRegistry.execute(command, 'ui').then((result) => {
    if (result.ok) persist(0);
  });
}

export function CanvasActionsProvider({ value, children }: { value: CanvasActions; children: ReactNode }) {
  return <CanvasActionsContext.Provider value={value}>{children}</CanvasActionsContext.Provider>;
}

/** Build the verb set once per canvas mount; every dependency is stable for the canvas lifetime. */
export function useCreateCanvasActions({
  reactFlow,
  wrapper,
  clipboard,
  scheduleCanvasPersist,
}: {
  reactFlow: ReactFlowInstance;
  wrapper: () => HTMLElement | null;
  clipboard: CanvasClipboardApi;
  scheduleCanvasPersist: (delayMs?: number) => void;
}): CanvasActions {
  return useMemo<CanvasActions>(() => {
    const viewportCenter = (): FlowPoint => {
      const rect = wrapper()?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return reactFlow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    };
    /** Visible canvas minus the floating chrome (left rail, bottom controls, top notice). */
    const safeViewport = (): CanvasPlacementViewport | null => {
      const rect = wrapper()?.getBoundingClientRect();
      if (!rect) return null;
      const { x, y, zoom } = reactFlow.getViewport();
      return {
        x: x - CHROME_INSET.left,
        y: y - CHROME_INSET.top,
        zoom,
        width: rect.width - CHROME_INSET.left - CHROME_INSET.right,
        height: rect.height - CHROME_INSET.top - CHROME_INSET.bottom,
      };
    };
    const version = CANVAS_COMMAND_VERSION;

    return {
      clipboard,
      viewportCenter,
      zoomIn: () => void reactFlow.zoomIn({ duration: 160 }),
      zoomOut: () => void reactFlow.zoomOut({ duration: 160 }),
      zoomTo: (zoom) => void reactFlow.zoomTo(zoom, { duration: 200 }),
      fitView: () => void reactFlow.fitView(FIT_OPTIONS),
      focusNodes: (nodeIds) => void reactFlow.fitView({ ...FIT_OPTIONS, nodes: nodeIds.map((id) => ({ id })) }),
      undo: () => {
        if (useCanvasStore.getState().undo()) scheduleCanvasPersist(0);
      },
      redo: () => {
        if (useCanvasStore.getState().redo()) scheduleCanvasPersist(0);
      },
      selectAll: () => {
        const { nodes, setSelectedNodeIds } = useCanvasStore.getState();
        setSelectedNodeIds(nodes.filter((node) => !node.parentId).map((node) => node.id));
      },
      clearSelection: () => {
        const { edges, onEdgesChange, setSelectedNode } = useCanvasStore.getState();
        setSelectedNode(null);
        const selectedEdges = edges.filter((edge) => edge.selected);
        if (selectedEdges.length > 0) {
          onEdgesChange(selectedEdges.map((edge) => ({ id: edge.id, type: 'select' as const, selected: false })));
        }
      },
      copySelection: () => {
        const ids = getSelectedNodeIds(useCanvasStore.getState().nodes);
        if (ids.length > 0) clipboard.copyNodes(ids);
      },
      duplicateSelection: () => {
        const ids = getSelectedNodeIds(useCanvasStore.getState().nodes);
        if (ids.length > 0) clipboard.duplicateNodes(ids);
      },
      deleteSelection: () => {
        // Nodes and edges in one transaction: one undo step. Edges touching deleted nodes go with them.
        const { nodes, edges } = useCanvasStore.getState();
        const nodeIds = getSelectedNodeIds(nodes);
        const doomed = new Set(nodeIds);
        const edgeIds = edges
          .filter((edge) => edge.selected && !doomed.has(edge.source) && !doomed.has(edge.target))
          .map((edge) => edge.id);
        const commands: CanvasCommand[] = [];
        if (nodeIds.length > 0) commands.push({ type: 'node.delete', version, input: { nodeIds } });
        if (edgeIds.length > 0) commands.push({ type: 'edge.disconnect', version, input: { edgeIds } });
        if (commands.length === 0) return;
        const result = canvasCommandRegistry.executeTransaction({
          id: `ui-delete-${Date.now().toString(36)}`,
          origin: 'ui',
          expectedRevision: canvasCommandRegistry.getRevision(),
          commands,
        });
        if (result.ok) scheduleCanvasPersist(0);
      },
      groupSelection: () => {
        const ids = getSelectedNodeIds(useCanvasStore.getState().nodes);
        if (ids.length > 1) run({ type: 'group.create', version, input: { nodeIds: ids } }, scheduleCanvasPersist);
      },
      ungroupSelection: () => {
        const groupIds = selectedNodes().filter((node) => node.type === CANVAS_NODE_TYPES.group).map((node) => node.id);
        if (groupIds.length > 0) run({ type: 'group.ungroup', version, input: { groupIds } }, scheduleCanvasPersist);
      },
      connectSelection: () => {
        // ⌘L: wire two selected nodes left → right by position.
        const nodes = selectedNodes();
        if (nodes.length !== 2) return;
        const [source, target] = [...nodes].sort((a, b) => a.position.x - b.position.x);
        run({ type: 'edge.connect', version, input: { sourceNodeId: source.id, targetNodeId: target.id } }, scheduleCanvasPersist);
      },
      generateSelection: () => {
        const nodes = useCanvasStore.getState().nodes;
        const selected = new Set(getSelectedNodeIds(nodes));
        // Disabled generators are skipped here; the generation facade also refuses them (reason 'disabled').
        const nodeIds = nodes
          .filter((node) => (selected.has(node.id) || (node.parentId && selected.has(node.parentId))) && GENERATION_TYPES.has(node.type)
            && !('enabled' in node.data && node.data.enabled === false))
          .map((node) => node.id);
        if (nodeIds.length > 0) void canvasCommandRegistry.execute({ type: 'generation.submit', version, input: { nodeIds } }, 'ui');
      },
      layoutSelection: (direction) => {
        const nodes = selectedNodes().filter((node) => !node.parentId);
        if (nodes.length < 2) return;
        const origin = {
          x: Math.min(...nodes.map((node) => node.position.x)),
          y: Math.min(...nodes.map((node) => node.position.y)),
        };
        run({ type: 'node.layout', version, input: { nodeIds: nodes.map((node) => node.id), direction, origin, gap: 40 } }, scheduleCanvasPersist);
      },
      organizeCanvas: () => {
        const { nodes, edges } = useCanvasStore.getState();
        const positions = planOrganizeCanvas(nodes, edges);
        if (positions.length === 0) return;
        void canvasCommandRegistry.execute({ type: 'node.move', version, input: { positions } }, 'ui').then((result) => {
          if (!result.ok) return;
          scheduleCanvasPersist(0);
          requestAnimationFrame(() => void reactFlow.fitView(FIT_OPTIONS));
        });
      },
      createNode: (type, position, configuration) => {
        if (position) {
          const nodeId = createCanvasNode({ type, position, configuration });
          if (nodeId) scheduleCanvasPersist(0);
          return nodeId;
        }
        const viewport = safeViewport();
        const nodeId = createCanvasNode({
          type,
          position: offsetToCenter(viewportCenter()),
          configuration,
          freePlacement: { viewport },
        });
        if (!nodeId) return null;
        scheduleCanvasPersist(0);
        // A full viewport leaves only off-screen slots: bring the new node into view, keeping zoom.
        requestAnimationFrame(() => {
          const node = reactFlow.getInternalNode(nodeId);
          if (!node || !viewport) return;
          const width = node.measured.width ?? 0;
          const height = node.measured.height ?? 0;
          const { x, y } = node.internals.positionAbsolute;
          const left = -viewport.x / viewport.zoom;
          const top = -viewport.y / viewport.zoom;
          const visible = x >= left && y >= top
            && x + width <= left + viewport.width / viewport.zoom
            && y + height <= top + viewport.height / viewport.zoom;
          if (!visible) void reactFlow.setCenter(x + width / 2, y + height / 2, { zoom: viewport.zoom, duration: 260 });
        });
        return nodeId;
      },
      openAddMenu: (client) => {
        let point = client;
        if (!point) {
          const rect = wrapper()?.getBoundingClientRect();
          if (!rect) return;
          point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        useCanvasUiStore.getState().openAddMenu({
          clientX: point.x,
          clientY: point.y,
          flowPosition: reactFlow.screenToFlowPosition(point),
        });
      },
    };
  }, [clipboard, reactFlow, scheduleCanvasPersist, wrapper]);
}

/** New nodes dropped "at the centre" should be centred, not hang off it by their top-left corner. */
function offsetToCenter(center: FlowPoint): FlowPoint {
  return { x: center.x - 240, y: center.y - 150 };
}
