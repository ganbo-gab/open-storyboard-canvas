import { create } from 'zustand';
import { AssetEditDialog } from './AssetEditDialog';
import { captureCanvasAssetEditTarget, saveCanvasAssetEdit, type CanvasAssetEditTarget } from '../application/canvasAssetEditing';

const useCanvasAssetEdit = create<{ target: CanvasAssetEditTarget | null; resultId: string }>(() => ({ target: null, resultId: '' }));
export function openCanvasAssetEditor(nodeId: string): void {
  useCanvasAssetEdit.setState({ target: captureCanvasAssetEditTarget(nodeId), resultId: crypto.randomUUID() });
}
export function CanvasAssetEditHost() {
  const { target, resultId } = useCanvasAssetEdit();
  if (!target) return null;
  return <AssetEditDialog key={resultId} asset={target.asset} onClose={() => useCanvasAssetEdit.setState({ target: null })}
    save={(output, details) => saveCanvasAssetEdit(target, output, details, resultId)} />;
}
