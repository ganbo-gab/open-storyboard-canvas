import { useMemo } from 'react';

import {
  parseInputReferenceSignature,
  selectInputReferenceSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import {
  collapseTagGroupReferenceOptions,
  type GraphReferenceItem,
} from '@/features/canvas/application/graphReferenceResolver';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useCanvasStore } from '@/stores/canvasStore';

export interface ComposerReference extends GraphReferenceItem {
  /** Thumbnail to show (image, or a video's poster); null for text/audio. */
  displayUrl: string | null;
}

export interface NodeReferences {
  /** Every upstream reference, numbered per kind (图1, 视1, 音1, 文1). */
  all: ComposerReference[];
  /** What `@` offers: tag groups collapse to one entry. */
  pickable: ComposerReference[];
}

/** Upstream references of a node, recomputed only when the referenced content changes. */
export function useNodeReferences(nodeId: string): NodeReferences {
  const signature = useCanvasStore((state) => selectInputReferenceSignature(nodeId, state.nodes, state.edges));
  return useMemo(() => {
    const all = parseInputReferenceSignature(signature).map((reference) => ({
      ...reference,
      displayUrl: reference.kind === 'image' && reference.imageUrl
        ? resolveImageDisplayUrl(reference.previewImageUrl || reference.imageUrl)
        : reference.kind === 'video' && reference.thumbnailUrl
          ? resolveImageDisplayUrl(reference.thumbnailUrl)
          : null,
    }));
    return { all, pickable: collapseTagGroupReferenceOptions(all) };
  }, [signature]);
}
