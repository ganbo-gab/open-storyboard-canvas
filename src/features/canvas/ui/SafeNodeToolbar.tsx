import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Position, useInternalNode, useReactFlow, useStore, useViewport } from "@xyflow/react";
import { useCanvasUiStore } from "@/features/canvas/state/canvasUiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { placeNodeOverlay, type OverlayPlacement } from "./overlayPlacement";

type Props = HTMLAttributes<HTMLDivElement> & {
  nodeId: string;
  isVisible?: boolean;
  position?: Position;
  offset?: number;
  /** This overlay is the node's composer: publish its rect so the top toolbar avoids it. */
  isComposer?: boolean;
  children: ReactNode;
};

/** Space reserved at the bottom of the canvas for the floating controls bar. */
const BOTTOM_CHROME = 64;
/** The tool rail floats on the left edge (12 + 44 + gap); overlays never slide under it. */
const LEFT_CHROME = 68;
const INSET = 12;
/** Room kept above a revealed node for its top toolbar. */
const TOP_RESERVE = 64;
const REVEAL_MS = 220;

/**
 * Controls live in viewport pixels, not in the zoomed graph. Clamp and flip at every edge.
 * Per-node controls belong to a sole selection; a multi-selection owns the selection bar.
 */
export function SafeNodeToolbar({
  nodeId,
  isVisible = true,
  position = Position.Top,
  offset = 16,
  isComposer = false,
  children,
  className = "",
  style,
  ...props
}: Props) {
  const root = useStore((state) => state.domNode);
  const node = useInternalNode(nodeId);
  const { x, y, zoom } = useViewport();
  const soleSelectedId = useCanvasStore((state) => state.selectedNodeId);
  const composer = useCanvasUiStore((state) => state.composerRect);
  const setComposerRect = useCanvasUiStore((state) => state.setComposerRect);
  const element = useRef<HTMLDivElement>(null);
  const { setViewport } = useReactFlow();
  const revealedFor = useRef<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [rootSize, setRootSize] = useState({ width: 0, height: 0 });
  const visible = Boolean(root && node && isVisible && !(node.selected && soleSelectedId !== nodeId));

  useLayoutEffect(() => {
    if (!root || !element.current || !visible) return;
    const update = () => {
      // Entrance transforms must not change the size used to clamp controls at an edge.
      const content = element.current;
      setRootSize((old) =>
        old.width === root.clientWidth && old.height === root.clientHeight
          ? old
          : { width: root.clientWidth, height: root.clientHeight },
      );
      if (content) {
        setSize((old) =>
          old.width === content.offsetWidth && old.height === content.offsetHeight ? old : { width: content.offsetWidth, height: content.offsetHeight },
        );
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [root, visible]);

  let placement: OverlayPlacement | null = null;
  /** Pixels the canvas must scroll up so the composer fits below the node. */
  let revealShift = 0;
  if (visible && node) {
    const anchor = {
      x: node.internals.positionAbsolute.x * zoom + x,
      y: node.internals.positionAbsolute.y * zoom + y,
      width: (node.measured.width ?? 300) * zoom,
      height: (node.measured.height ?? 200) * zoom,
    };
    const usableHeight = Math.max(0, rootSize.height - BOTTOM_CHROME);
    placement = placeNodeOverlay(
      { ...anchor, x: anchor.x - LEFT_CHROME },
      size,
      { width: Math.max(0, rootSize.width - LEFT_CHROME), height: usableHeight },
      position === Position.Bottom ? "bottom" : "top",
      offset,
    );
    placement.x += LEFT_CHROME;
    if (position === Position.Bottom) {
      // Below the node, or docked to the bottom edge — never above it, where the toolbar lives.
      const below = anchor.y + anchor.height + offset;
      const overflow = below + size.height - (usableHeight - INSET);
      revealShift = overflow > 0 ? Math.min(overflow, Math.max(0, anchor.y - TOP_RESERVE)) : 0;
      placement.y = overflow <= 0 ? below : Math.max(INSET, usableHeight - size.height - INSET);
    } else if (composer?.nodeId === nodeId && placement.y < composer.bottom && placement.y + size.height > composer.top) {
      placement.y = INSET;
    }
  }

  // On open, scroll the canvas once so the composer sits under the node instead of covering it.
  // Docking stays as the fallback for nodes too tall to show both; later manual pans are respected.
  const measured = size.height > 0;
  useLayoutEffect(() => {
    if (!isComposer || !visible) {
      revealedFor.current = null;
      return;
    }
    if (!measured || revealedFor.current === nodeId) return;
    revealedFor.current = nodeId;
    if (useCanvasUiStore.getState().preservePasteViewportFor === nodeId) {
      useCanvasUiStore.setState({ preservePasteViewportFor: null });
      return;
    }
    if (revealShift < 1) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    void setViewport({ x, y: y - revealShift, zoom }, { duration: reduceMotion ? 0 : REVEAL_MS });
    // Runs once per opening; the viewport values are read at that moment on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComposer, visible, measured, nodeId]);

  const composerTop = isComposer && placement ? Math.round(placement.y) : null;
  const composerBottom = composerTop === null ? null : composerTop + Math.round(size.height);
  useLayoutEffect(() => {
    if (composerTop === null || composerBottom === null) return;
    setComposerRect({ nodeId, top: composerTop, bottom: composerBottom });
  }, [composerBottom, composerTop, nodeId, setComposerRect]);
  useLayoutEffect(() => {
    if (!isComposer || !visible) return;
    return () => {
      if (useCanvasUiStore.getState().composerRect?.nodeId === nodeId) setComposerRect(null);
    };
  }, [isComposer, nodeId, setComposerRect, visible]);

  if (!root || !placement) return null;
  return createPortal(
    <div
      {...props}
      data-canvas-no-marquee="true"
      data-canvas-overlay=""
      data-node-overlay-owner={nodeId}
      className={`nodrag nopan nowheel canvas-safe-overlay absolute ${className}`}
      style={{
        zIndex: position === Position.Bottom ? 11020 : 11000,
        left: placement.x,
        top: placement.y,
        maxWidth: Math.max(0, rootSize.width - LEFT_CHROME - INSET * 2),
        maxHeight: placement.maxHeight,
        visibility: size.width ? "visible" : "hidden",
        ...style,
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        props.onPointerDown?.(event);
      }}
    >
      <div ref={element} className="canvas-safe-overlay__content">
        {children}
      </div>
    </div>,
    root,
  );
}
