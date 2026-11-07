import { ArrowDown, ArrowUp } from 'lucide-react';
import { UiButton, UiCheckbox, UiField, UiModal, UiSlider, UiSwitch } from '@/components/ui';
import { useSettingsStore } from '@/stores/settingsStore';
import { arrangeToolbarItems, normalizeWorkspacePreferences } from './workspacePreferences';

export function ToolbarPreferencesDialog({ target, items, onClose }: { target: 'nodeToolbar' | 'canvasRail'; items: { id: string; label: string }[]; onClose(): void }) {
  const prefs = useSettingsStore((state) => state.workspacePreferences);
  const update = useSettingsStore((state) => state.setWorkspacePreferences);
  const config = prefs[target];
  const all = arrangeToolbarItems(items, { ...config, limit: 12, hidden: [] });
  const ordered = [...all.visible, ...all.more];
  const move = (id: string, offset: number) => {
    const ids = ordered.map((item) => item.id); const index = ids.indexOf(id); const next = index + offset;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    update({ [target]: { ...config, pinned: ids } });
  };
  return <UiModal isOpen title={target === 'nodeToolbar' ? '自定义节点工具栏' : '自定义画布侧栏'} onClose={onClose}
    description="常用操作显示在外面，其余操作始终可以在“更多”中找到。调整后自动保存。"
    footer={<><UiButton onClick={() => update({ [target]: normalizeWorkspacePreferences(undefined)[target] })}>恢复默认</UiButton><UiButton variant="primary" onClick={onClose}>完成</UiButton></>}>
    <div className="space-y-5">
      <UiField label={`最多显示 ${config.limit} 项`} hint={target === 'canvasRail' ? '添加、选择和抓手固定保留，不计入此数量。' : '窗口变窄时会自动减少，避免遮挡画布。'}>
        <UiSlider aria-label="常用操作显示数量" value={config.limit} min={0} max={12} step={1} onChange={(limit) => update({ [target]: { ...config, limit } })} />
      </UiField>
      <div className="space-y-1">{ordered.map((item, index) => <div key={item.id} className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-(--hover)">
        <UiCheckbox aria-label={`常驻 ${item.label}`} checked={!config.hidden.includes(item.id)} onCheckedChange={(checked) => update({ [target]: { ...config, hidden: checked ? config.hidden.filter((id) => id !== item.id) : [...config.hidden, item.id] } })} />
        <span className="min-w-0 flex-1 text-sm">{item.label}</span>
        <UiButton size="sm" variant="ghost" aria-label={`上移 ${item.label}`} disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp className="h-4 w-4" /></UiButton>
        <UiButton size="sm" variant="ghost" aria-label={`下移 ${item.label}`} disabled={index === ordered.length - 1} onClick={() => move(item.id, 1)}><ArrowDown className="h-4 w-4" /></UiButton>
      </div>)}</div>
      <div className="flex items-center justify-between gap-4 border-t border-line pt-4"><span className="text-sm">允许拖动调整面板大小</span><UiSwitch aria-label="允许拖动调整面板大小" checked={prefs.resizePanels} onCheckedChange={(resizePanels) => update({ resizePanels })} /></div>
    </div>
  </UiModal>;
}
