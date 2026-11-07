import { useState } from 'react';
import { Check, ChevronDown, FolderKanban } from 'lucide-react';
import { MenuItem, MenuSurface, UiButton, anchorBelow, type MenuAnchor } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkbenchStore } from '../store/workbenchStore';

export function ConversationProjectPicker({ conversationId, onFilter }: { conversationId: string; onFilter(id: string): void }) {
  const projects = useProjectStore(state => state.projects);
  const projectId = useWorkbenchStore(state => state.conversations[conversationId]?.projectId);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [notice, setNotice] = useState('');
  const project = projects.find(item => item.id === projectId);
  const choose = (id: string | null) => {
    useWorkbenchStore.getState().associateConversationProject(conversationId, id);
    setNotice(id ? `已归入「${projects.find(item => item.id === id)?.name}」` : '已移出项目分组');
    onFilter(id ?? 'none');
    setAnchor(null);
  };
  return <div className="relative min-w-0 max-w-64 shrink-0">
    <UiButton size="sm" variant="ghost" aria-label="设置会话归属项目" aria-expanded={Boolean(anchor)} title={project ? `归属项目：${project.name}` : '设置会话归属项目'} className="max-w-full gap-2" onClick={event => {
      setAnchor(anchor ? null : anchorBelow(event.currentTarget));
    }}><FolderKanban className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">{project?.name ?? (projectId ? '原项目已删除' : '归属项目')}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" /></UiButton>
    <span role="status" className="sr-only">{notice}</span>
    {anchor && <MenuSurface anchor={anchor} width={320} label="会话归属项目" onClose={() => setAnchor(null)}>
      <div className="border-b border-line px-3 pb-3 pt-2"><p className="text-sm font-medium">会话归属</p><p className="mt-1 text-xs leading-5 text-text-muted">按项目整理创作记录。之后生成的资产会归入所选项目；已有资产保持原归属。生成结果仍需点击“放入画布”。</p></div>
      <MenuItem label="不归入项目" icon={!projectId ? <Check /> : <FolderKanban />} onClick={() => choose(null)} />
      <div className="max-h-64 overflow-y-auto">{projects.map(item => <MenuItem key={item.id} label={item.name} icon={projectId === item.id ? <Check /> : <FolderKanban />} onClick={() => choose(item.id)} />)}</div>
      {!projects.length && <p className="p-3 text-xs text-text-muted">先在“项目”中新建一个画布项目。</p>}
    </MenuSurface>}
  </div>;
}
