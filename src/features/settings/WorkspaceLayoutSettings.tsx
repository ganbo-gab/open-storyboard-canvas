import { UiField, UiSlider, UiSwitch } from '@/components/ui';
import { useSettingsStore } from '@/stores/settingsStore';

export function WorkspaceLayoutSettings() {
  const prefs = useSettingsStore((state) => state.workspacePreferences);
  const update = useSettingsStore((state) => state.setWorkspacePreferences);
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
    <h3 className="text-sm font-medium text-text-dark">工具栏与面板</h3>
    <p className="text-xs text-text-muted">在画布侧栏或节点工具栏的“更多 → 自定义”中选择显示项目并调整顺序。</p>
    <UiField label={`节点工具栏最多显示 ${prefs.nodeToolbar.limit} 项`}><UiSlider aria-label="节点工具栏显示数量" min={0} max={12} step={1} value={prefs.nodeToolbar.limit} onChange={(limit) => update({ nodeToolbar: { ...prefs.nodeToolbar, limit } })} /></UiField>
    <UiField label={`画布侧栏最多显示 ${prefs.canvasRail.limit} 项`}><UiSlider aria-label="画布侧栏显示数量" min={0} max={12} step={1} value={prefs.canvasRail.limit} onChange={(limit) => update({ canvasRail: { ...prefs.canvasRail, limit } })} /></UiField>
    <div className="flex items-center justify-between gap-4"><div><p className="text-sm">允许调整面板大小</p><p className="mt-1 text-xs text-text-muted">拖动页面分隔线或浮窗边角调整大小，双击分隔线恢复默认。关闭后锁定当前尺寸。</p></div><UiSwitch aria-label="允许调整面板大小" checked={prefs.resizePanels} onCheckedChange={(resizePanels) => update({ resizePanels })} /></div>
    <button type="button" className="text-xs text-accent" onClick={() => update({ panelSizes: {}, sidebarWidths: {} })}>恢复面板默认大小</button>
  </section>;
}
