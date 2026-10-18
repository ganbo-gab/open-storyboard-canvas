import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Position,
  useInternalNode,
  useStore,
  useViewport,
} from "@xyflow/react";
import { placeNodeOverlay } from "./overlayPlacement";

type Props = HTMLAttributes<HTMLDivElement> & {
  nodeId: string;
  isVisible?: boolean;
  position?: Position;
  align?: "start" | "center" | "end";
  offset?: number;
  children: ReactNode;
};

/** Controls live in viewport pixels, not in the zoomed graph. Clamp and flip at every edge. */
export function SafeNodeToolbar({
  nodeId,
  isVisible = true,
  position = Position.Top,
  offset = 16,
  align: _align,
  children,
  className = "",
  style,
  ...props
}: Props) {
  const root = useStore((state) => state.domNode);
  const node = useInternalNode(nodeId);
  const { x, y, zoom } = useViewport();
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!root || !element.current || !isVisible) return;
    const update = () => {
      const bounds = element.current?.getBoundingClientRect();
      setViewport((old) =>
        old.width === root.clientWidth && old.height === root.clientHeight
          ? old
          : { width: root.clientWidth, height: root.clientHeight },
      );
      if (bounds)
        setSize((old) =>
          old.width === bounds.width && old.height === bounds.height
            ? old
            : { width: bounds.width, height: bounds.height },
        );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [root, isVisible]);
  if (!root || !node || !isVisible) return null;
  const anchor = {
    x: node.internals.positionAbsolute.x * zoom + x,
    y: node.internals.positionAbsolute.y * zoom + y,
    width: (node.measured.width ?? 300) * zoom,
    height: (node.measured.height ?? 200) * zoom,
  };
  const placement = placeNodeOverlay(
    anchor,
    size,
    { width: viewport.width, height: Math.max(0, viewport.height - 64) },
    position === Position.Bottom ? "bottom" : "top",
    offset,
  );
  const usableHeight = Math.max(0, viewport.height - 64);
  const composerHeight =
    node.type === "aiVideoNode" ? 260 : node.type === "imageNode" ? 240 : 0;
  if (position === Position.Bottom) {
    const below = anchor.y + anchor.height + offset;
    placement.y =
      below + size.height <= usableHeight - 12
        ? below
        : Math.max(12, usableHeight - size.height - 12);
  } else if (composerHeight && node.selected) {
    const below = anchor.y + anchor.height + 18;
    const composerTop =
      below + composerHeight <= usableHeight - 12
        ? below
        : Math.max(12, usableHeight - composerHeight - 12);
    if (
      placement.y < composerTop + composerHeight &&
      placement.y + size.height > composerTop
    )
      placement.y = 12;
  }
  return createPortal(
    <div
      {...props}
      data-canvas-no-marquee="true"
      className={`nodrag nopan nowheel canvas-safe-overlay absolute ${className}`}
      style={{
        zIndex: position === Position.Bottom ? 11020 : 11000,
        left: placement.x,
        top: placement.y,
        maxWidth: Math.max(0, viewport.width - 24),
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
