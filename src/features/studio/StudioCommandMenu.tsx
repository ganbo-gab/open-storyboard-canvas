import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Command, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiModal } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import { requestStudioPageNavigation } from './studioNavigation';
import { openSettingsDialog } from '@/features/settings/settingsEvents';

export function StudioCommandMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'commands' | 'shortcuts' | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const projects = useProjectStore((state) => state.projects);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.director-studio-shell')) return;
      const typing = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen('commands'); setQuery(''); setSelected(0); }
      else if (event.key === '?' && !typing && !document.querySelector('[aria-modal="true"]')) { event.preventDefault(); setOpen('shortcuts'); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (open === 'commands') input.current?.focus(); }, [open]);
  const pages = ['home', 'workbench', 'projects', 'assets', 'characters', 'agent'] as const;
  const label = { home: 'rework.home', workbench: 'rework.workbench', projects: 'rework.projects', assets: 'rework.assets', characters: 'rework.charactersNav', agent: 'rework.agent.home' };
  const commands = [
    { id: 'new', title: t('rework.newCanvas'), run: () => { useProjectStore.getState().createProject(t('rework.untitled')); } },
    ...pages.map((view) => ({ id: view, title: t(label[view]), run: () => requestStudioPageNavigation(view) })),
    { id: 'settings', title: t('rework.settings'), run: () => openSettingsDialog({ category: 'providersChat' }) },
    ...[...projects].sort((a, b) => b.updatedAt - a.updatedAt).map((project) => ({ id: project.id, title: project.name, run: () => useProjectStore.getState().openProject(project.id) })),
  ].filter((entry) => entry.title.toLowerCase().includes(query.trim().toLowerCase()));
  const execute = (index: number) => { const entry = commands[index]; if (!entry) return; setOpen(null); entry.run(); };
  return <UiModal isOpen={Boolean(open)} title={t(open === 'shortcuts' ? 'ui.workbench.shortcuts' : 'ui.workbench.commandMenu')} onClose={() => setOpen(null)} widthClassName="w-[min(560px,calc(100vw-2rem))]" containerClassName="!z-[9000]">
    {open === 'commands' ? <div onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => Math.max(0, Math.min(commands.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); execute(selected); }
    }}><label className="workbench-search !h-11"><Search size={18} /><input ref={input} value={query} placeholder={t('ui.workbench.findAction')} aria-label={t('ui.workbench.findAction')} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} /></label><div className="ui-scrollbar mt-3 max-h-[50vh] overflow-auto">{commands.map((entry, index) => <button type="button" key={entry.id} className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm ${index === selected ? 'bg-raised text-text' : 'text-text-muted'}`} onMouseEnter={() => setSelected(index)} onClick={() => execute(index)}><Command size={15} className="text-text-subtle" /><span className="min-w-0 flex-1 truncate">{entry.title}</span><ArrowRight size={14} /></button>)}</div></div>
      : <dl className="space-y-4 text-sm">{[['⌘ / Ctrl K', 'commandMenu'], ['?', 'shortcuts'], ['Enter', 'sendMessage'], ['Shift Enter', 'newLine'], ['Esc', 'closeLayer'], ['⌘ / Ctrl Z', 'undo'], ['Space', 'panCanvas']].map(([key, name]) => <div key={key} className="flex items-center justify-between gap-4"><dt className="text-text-muted">{t(`ui.workbench.${name}`)}</dt><dd className="rounded-md bg-raised px-2 py-1 font-mono text-xs">{key}</dd></div>)}</dl>}
  </UiModal>;
}
