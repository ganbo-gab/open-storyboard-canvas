import { useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { ReferenceUploadAction } from '@/features/channels/ui/ReferenceUploadAction';
import { normalizeChannelGenerationFields } from '@/features/channels/application/generationFields';
import type { GenerationReferenceFailure } from '../domain/canvasNodes';
import { retryGenerationWithHostedReference } from '../application/generation';

/** Hosted-reference retry on a failed result node; the slot sources live on the generating node. */
export function GenerationReferenceRetry({ nodeId, failure }: { nodeId: string; failure: GenerationReferenceFailure }) {
  const slotSourceCount = useCanvasStore((state) => {
    const source = state.nodes.find((node) => node.id === failure.sourceNodeId);
    return source ? normalizeChannelGenerationFields(source.data).referenceSlots?.[failure.slotKey]?.length ?? 0 : 0;
  });
  const retry = useCallback(async (confirmation: { confirmed: true }) => {
    const outcome = await retryGenerationWithHostedReference(nodeId, confirmation);
    if (!outcome.ok) throw new Error(outcome.message);
  }, [nodeId]);
  return <ReferenceUploadAction className="nodrag nopan mt-1 items-center" failure={failure} slotSourceCount={slotSourceCount} onUploadConfirmed={retry} />;
}
