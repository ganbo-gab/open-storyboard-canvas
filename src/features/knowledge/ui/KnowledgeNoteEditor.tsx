import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm, UiTextArea } from '@/components/ui';
import { assertVaultRelativePath, type VaultNote } from '../domain/types';
import { extractWikiLinks, parseMarkdown, resolveWikiTarget } from '../domain/markdown';

type Draft = { base: string; content: string };
const sessionDrafts = new Map<string, Draft>();
const warnUnsaved = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
function cacheDraft(key: string, draft: Draft) {
  const wasEmpty = sessionDrafts.size === 0;
  if (draft.content === draft.base) sessionDrafts.delete(key); else sessionDrafts.set(key, draft);
  if (wasEmpty && sessionDrafts.size > 0) window.addEventListener('beforeunload', warnUnsaved);
  if (!wasEmpty && sessionDrafts.size === 0) window.removeEventListener('beforeunload', warnUnsaved);
}

export function KnowledgeNoteEditor({ note, vaultPath, paths, missing = false, onSave, onOpen, onDirtyChange, onError }: {
  note: VaultNote; vaultPath: string; paths: readonly string[]; missing?: boolean;
  onSave(content: string): Promise<void>;
  onOpen(path: string): void;
  onDirtyChange(dirty: boolean): void;
  onError(message: string): void;
}) {
  const { t } = useTranslation();
  const key = `${vaultPath}\u0000${note.path}`;
  const [draft, setDraft] = useState<Draft>(() => sessionDrafts.get(key) ?? { base: note.content, content: note.content });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [notice, setNotice] = useState('');
  const dirty = draft.base !== draft.content;
  const conflict = dirty && note.content !== draft.base;
  useEffect(() => {
    if (!dirty) setDraft({ base: note.content, content: note.content });
  }, [note.content, dirty]);
  useEffect(() => { cacheDraft(key, draft); onDirtyChange(dirty); }, [key, draft, dirty, onDirtyChange]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(draft.content);
      cacheDraft(key, { base: draft.content, content: draft.content });
      setDraft({ base: draft.content, content: draft.content });
      setNotice(t('rework.knowledge.saved'));
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const markdown = useMemo(() => {
    let body: string;
    try { body = parseMarkdown(draft.content).body; } catch { body = draft.content; }
    // Use the domain parser so code spans/fences are not rewritten as wiki links.
    for (const link of extractWikiLinks(body).reverse()) {
      const target = resolveWikiTarget(link.target, note.path, paths);
      if (!target) continue;
      const label = link.alias || link.target;
      const replacement = link.embed && !/\.md$/i.test(target)
        ? `![${label}](#vault-asset:${encodeURIComponent(target)})`
        : `[${label}](#vault-note:${encodeURIComponent(target)})`;
      body = body.slice(0, link.start) + replacement + body.slice(link.end);
    }
    return body;
  }, [draft.content, note.path, paths]);
  const imageSource = (src: string | undefined): string | null => {
    if (!src || /^(?:https?:|data:|blob:|file:|\/\/)/i.test(src)) return null;
    try {
      const path = src.startsWith('#vault-asset:') ? decodeURIComponent(src.slice('#vault-asset:'.length))
        : decodeURIComponent(new URL(src, `https://vault.invalid/${note.path}`).pathname.slice(1));
      return convertFileSrc(`${vaultPath}/${assertVaultRelativePath(path)}`);
    } catch { return null; }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-3">
      <div className="min-w-0"><h2 className="truncate text-sm font-medium text-text-dark">{note.path}</h2><p className="mt-0.5 text-[10.5px] text-text-muted">{t(dirty ? 'rework.knowledge.draftHint' : 'rework.knowledge.savedHint')}</p></div>
      <div className="flex flex-wrap items-center gap-2"><UiButton size="sm" variant="ghost" onClick={() => setPreview(value => !value)}>{t(preview ? 'rework.knowledge.edit' : 'rework.knowledge.preview')}</UiButton><UiButton size="sm" variant="ghost" icon={<Copy />} onClick={() => { void navigator.clipboard.writeText(draft.content).then(() => setNotice(t('rework.copied')), (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))); }}>{t('rework.copyText')}</UiButton><UiButton size="sm" variant="primary" icon={<Save />} loading={busy} disabled={!dirty && !missing} onClick={() => { if (conflict && !missing) setOverwrite(true); else void save(); }}>{t(missing ? 'rework.knowledge.saveAsNew' : 'common.save')}</UiButton></div>
    </header>
    {conflict && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/5 px-4 py-2 text-xs leading-5 text-warning"><span>{t('rework.knowledge.externalChange')}</span><UiButton size="sm" variant="ghost" onClick={() => { setDraft({ base: note.content, content: note.content }); cacheDraft(key, { base: note.content, content: note.content }); }}>{t('rework.knowledge.loadExternal')}</UiButton></div>}
    {missing && <p role="alert" className="border-b border-warning/30 px-4 py-2 text-xs leading-5 text-warning">{t('rework.knowledge.noteMissing')}</p>}
    {notice && <p role="status" className="px-4 pt-2 text-xs text-success">{notice}</p>}
    <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
      {preview ? <div className="prose prose-sm max-w-none break-words text-text-dark dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href?.startsWith('#vault-note:')
          ? <button type="button" className="text-accent underline underline-offset-2" onClick={() => onOpen(decodeURIComponent(href.slice('#vault-note:'.length)))}>{children}</button>
          : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
        img: ({ src, alt }) => {
          const url = imageSource(typeof src === 'string' ? src : undefined);
          return url ? <img src={url} alt={alt ?? ''} className="max-w-full rounded-lg" loading="lazy" />
            : <span className="text-xs text-text-muted">{t('rework.knowledge.imageNotLoaded', { name: alt || src || '' })}</span>;
        },
      }}>{markdown}</ReactMarkdown></div> : <UiTextArea aria-label={t('rework.knowledge.noteContent')} value={draft.content} onChange={event => setDraft(current => ({ ...current, content: event.target.value }))}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (conflict && !missing) setOverwrite(true); else void save(); } }}
        className="min-h-full w-full resize-none border-0 bg-transparent p-0 font-mono text-[13px] leading-7 focus:ring-0" spellCheck={false} />}
    </div>
    <UiConfirm isOpen={overwrite} title={t('rework.knowledge.overwriteTitle')} description={t('rework.knowledge.overwriteDescription')} onClose={() => setOverwrite(false)} onConfirm={() => void save()} />
  </div>;
}
