import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiInput, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useToolboxStore } from '../toolbox/toolboxStore';

export function SaveGroupTemplateDialog({ groupId, onClose }: { groupId: string; onClose(): void }) {
  const { t } = useTranslation();
  const group = useCanvasStore(state => state.nodes.find(node => node.id === groupId));
  const [name, setName] = useState(() => group ? resolveNodeDisplayName(group.type, group.data) : '');
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const store = useCanvasStore.getState();
      await useToolboxStore.getState().saveGroup(groupId, store.nodes, store.edges, { name, color: color || undefined });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <UiModal isOpen title={t('rework.toolbox.saveGroup')} onClose={() => { if (!busy) onClose(); }}
    footer={<><UiButton variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</UiButton><UiButton variant="primary" loading={busy} disabled={!name.trim() || !group} onClick={() => void save()}>{t('common.save')}</UiButton></>}>
    <div className="space-y-4"><p className="text-xs leading-6 text-text-muted">{t('rework.toolbox.captureHint')}</p><UiField label={t('rework.toolbox.name')}><UiInput autoFocus value={name} maxLength={200} onChange={event => setName(event.target.value)} /></UiField><UiField label={t('rework.toolbox.color')}><div className="flex items-center gap-2"><UiInput type="color" value={color || '#808080'} onChange={event => setColor(event.target.value)} className="h-9 w-14 p-1" /><UiButton size="sm" variant="ghost" onClick={() => setColor('')}>{t('rework.toolbox.defaultColor')}</UiButton></div></UiField>{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div>
  </UiModal>;
}
