import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
import { placeNodeOverlay } from "./overlayPlacement";

type Props = HTMLAttributes<HTMLDivElement> & {
  container: RefObject<HTMLDivElement | null>;
  anchor: { left: number; top: number };
};

/** Caret menus use viewport pixels and escape the editor's clipping/stacking context. */
export function EditorPopup({
  container,
  anchor,
  className = "",
  children,
  ...props
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const { x, y, zoom } = useViewport();
  const [geometry, setGeometry] = useState({
    x: 12,
    y: 12,
    maxHeight: 260,
    ready: false,
  });
  useLayoutEffect(() => {
    const update = () => {
      const owner = container.current?.getBoundingClientRect();
      const menu = element.current?.getBoundingClientRect();
      if (!owner || !menu) return;
      const placement = placeNodeOverlay(
        {
          x: owner.left + anchor.left,
          y: owner.top + anchor.top,
          width: 0,
          height: 0,
        },
        menu,
        { width: window.innerWidth, height: window.innerHeight },
        "bottom",
        6,
      );
      setGeometry((old) =>
        old.x === placement.x &&
        old.y === placement.y &&
        old.maxHeight === placement.maxHeight &&
        old.ready
          ? old
          : { ...placement, ready: true },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (element.current) observer.observe(element.current);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [container, anchor.left, anchor.top, x, y, zoom]);
  return createPortal(
    <div
      {...props}
      ref={element}
      data-canvas-no-marquee="true"
      className={`nodrag nopan nowheel ${className}`}
      style={{
        position: "fixed",
        zIndex: 12000,
        left: geometry.x,
        top: geometry.y,
        maxWidth: "calc(100vw - 24px)",
        maxHeight: geometry.maxHeight,
        overflowY: "auto",
        visibility: geometry.ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
