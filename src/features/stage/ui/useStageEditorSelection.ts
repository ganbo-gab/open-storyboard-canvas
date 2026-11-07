import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { resolveStageSelection, type StageSelectionChange, type StageSelectionOperation } from '../application/stageSelection';
import { stageCommands } from '../application/stageCommands';

export function useStageEditorSelection(nodeId: string, items: BlueprintItem[], primary: string | null, onPrimary: (id: string | null) => void) {
  const [ids, setIds] = useState<string[]>(primary ? [primary] : []);
  const current = useRef(ids); current.current = ids;
  useEffect(() => {
    setIds((previous) => {
      const valid = previous.filter((id) => items.some((item) => item.id === id));
      const next = primary ? valid.includes(primary) ? valid : [primary] : [];
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
    });
  }, [items, primary]);
  const select = useCallback((itemIds: string[], source: StageSelectionChange['source'], toggle = false) => {
    const next = resolveStageSelection(items, current.current, { itemIds, source, mode: toggle ? 'toggle' : 'replace' });
    current.current = next.itemIds; setIds(next.itemIds); onPrimary(next.primaryItemId);
  }, [items, onPrimary]);
  const apply = useCallback((operation: StageSelectionOperation, targets = current.current) => {
    const result = stageCommands.executeSelection(nodeId, targets, operation);
    current.current = result.selection.itemIds; setIds(result.selection.itemIds); onPrimary(result.selection.primaryItemId);
  }, [nodeId, onPrimary]);
  return { ids, select, apply };
}
