import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

/**
 * Metadata consumers must not invalidate their indexes on pan/drag/selection-only changes.
 * Returned nodes deliberately do not carry live geometry; never use this projection for layout.
 */
export function createCanvasContentSelector(): (nodes: CanvasNode[]) => CanvasNode[] {
  let input: CanvasNode[] | undefined;
  let content: CanvasNode[] | undefined;
  return (nodes) => {
    if (nodes === input) return content ?? nodes;
    input = nodes;
    if (content && content.length === nodes.length) {
      let unchanged = true;
      for (let index = 0; index < nodes.length; index += 1) {
        const previous = content[index];
        const next = nodes[index];
        if (previous.id !== next.id || previous.type !== next.type || previous.data !== next.data
          || previous.parentId !== next.parentId) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return content;
    }
    content = nodes;
    return nodes;
  };
}

/** Shared across asset/reference consumers so each immutable input array is scanned only once. */
export const selectCanvasContentNodes = createCanvasContentSelector();
