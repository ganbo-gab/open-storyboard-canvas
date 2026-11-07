import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { Node as TipTapNode, mergeAttributes, type Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { EditorContent, useEditor, ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { AtSign, FileText, Maximize2, Music, Search, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MenuLabel, MenuSurface, anchorToElement, UiModal, UiButton, type MenuAnchor } from '@/components/ui';
import { promptDocument, promptPositionAtOffset, promptTextOffset, normalizeReferenceTriggers } from './promptDocument';
import type { PromptDraft } from './usePromptDraft';
import type { ComposerReference } from './useNodeReferences';

export interface SlashCommand { id: string; label: string; hint?: string; icon?: ReactNode; selected?: boolean; focusEditor?: boolean; run(): void }
export type PastedImageResolver = (event: Pick<ClipboardEvent<HTMLTextAreaElement>, 'clipboardData' | 'nativeEvent'>) => File | null;
interface PromptEditorProps {
  draft: PromptDraft;
  references: readonly ComposerReference[];
  pickable: readonly ComposerReference[];
  slashCommands?: readonly SlashCommand[];
  sourceChip?: { label: string; onClear(): void } | null;
  placeholder: string;
  onSubmit(): void;
  onPasteImage?: (file: File) => Promise<string | null>;
  resolvePastedImage?: PastedImageResolver;
  autoFocus?: boolean;
  submitOnEnter?: boolean;
  referencePickerRequest?: number;
  slashPickerRequest?: number;
  onUploadReference?(): void;
  onChooseAsset?(): void;
}
function ReferenceChip({ node }: NodeViewProps) {
  const source = typeof node.attrs.source === 'string' ? node.attrs.source : '';
  return <NodeViewWrapper as="span" className="composer-token" data-prompt-reference="" contentEditable={false} title={String(node.attrs.title ?? '')}>
    {source && <span className="composer-token__image"><AssetMedia source={source} kind="image" draggable={false} /></span>}
    <span>{String(node.attrs.token ?? '')}</span>
  </NodeViewWrapper>;
}
const Reference = TipTapNode.create({
  name: 'promptReference', group: 'inline', inline: true, atom: true, selectable: false,
  addAttributes() { return { token: { default: '' }, title: { default: '' }, source: { default: '' } }; },
  addNodeView() { return ReactNodeViewRenderer(ReferenceChip); },
  parseHTML() { return [{ tag: 'span[data-prompt-reference]' }]; },
  renderHTML({ node, HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-prompt-reference': '', class: 'composer-token', contenteditable: 'false', title: node.attrs.title }), node.attrs.token]; },
  renderText({ node }) { return String(node.attrs.token); },
});
function referenceIcon(reference: ComposerReference) {
  if (reference.displayUrl) return <AssetMedia source={reference.displayUrl} kind="image" className="composer-ref-thumb" draggable={false} />;
  return reference.kind === 'video' ? <Video /> : reference.kind === 'audio' ? <Music /> : <FileText />;
}
/** Adapted from video-maker's TipTap composer: native editing/IME, inline references, local undo. */
export function PromptEditor(props: PromptEditorProps) {
  const { t } = useTranslation();
  const latest = useRef(props); latest.current = props;
  const [picker, setPicker] = useState<{ kind: 'reference' | 'slash'; anchor: MenuAnchor; position: number; end?: number; typed?: boolean } | null>(null);
  const pickerRef = useRef(picker); pickerRef.current = picker;
  const [search, setSearch] = useState('');
  const [activeOption, setActiveOption] = useState(0);
  const activeOptionRef = useRef(activeOption); activeOptionRef.current = activeOption;
  const searchRef = useRef(search); searchRef.current = search;
  const runSlashRef = useRef<(command: SlashCommand) => void>(() => {});
  const pickReferenceRef = useRef<(reference: ComposerReference) => void>(() => {});
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [compositionVersion, setCompositionVersion] = useState(0);
  const ownerKey = props.draft.key;
  const pasteAnchors = useRef(new Map<symbol, { editor: Editor; key: string | undefined; position: number }>());
  const referenceSignature = JSON.stringify(props.references.map(({ sourceNodeId, token, title, displayUrl }) => [sourceNodeId, token, title, displayUrl]));
  const previousReferences = useRef(referenceSignature);
  const extensions = useMemo(() => [Document, Paragraph, Text, HardBreak, UndoRedo, Reference, Placeholder.configure({ placeholder: () => latest.current.placeholder })], []);
  const refreshReferencePicker = (instance: Editor) => {
    if (instance.isDestroyed || instance.view.composing) return;
    if (pickerRef.current?.kind === 'slash' && !pickerRef.current.typed) return;
    const { $from, empty } = instance.state.selection;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
    const slashMatch = empty && latest.current.slashCommands?.length ? /(?:^|[\s，。！？：；\p{Script=Han}])([/／][^/／\s\ufffc]*)$/u.exec(before) : null;
    if (slashMatch) {
      const from = $from.pos - slashMatch[1].length;
      const rect = instance.view.coordsAtPos(from);
      setSearch(slashMatch[1].slice(1)); setActiveOption(0);
      setPicker({ kind: 'slash', typed: true, position: from, end: $from.pos, anchor: anchorToElement(instance.view.dom, { x: rect.left, y: rect.top - 8, placement: 'above', flipY: rect.bottom + 8 }) });
      return;
    }
    if (pickerRef.current?.kind === 'slash') setPicker(null);
    const match = empty ? /[@＠]+([^@＠\s\ufffc]*)$/.exec(before) : null;
    if (!match || /[A-Za-z0-9_.]/.test(before[match.index - 1] ?? '')) {
      if (pickerRef.current?.kind === 'reference') setPicker(null);
      return;
    }
    const from = $from.pos - match[0].length;
    const rect = instance.view.coordsAtPos(from);
    setSearch(match[1]); setActiveOption(0);
    setPicker({ kind: 'reference', position: from, end: $from.pos, anchor: anchorToElement(instance.view.dom, { x: rect.left, y: rect.top - 8, placement: 'above', flipY: rect.bottom + 8 }) });
  };
  const editor = useEditor({
    extensions, immediatelyRender: false, content: promptDocument(props.draft.value, props.references),
    editorProps: {
      attributes: { 'aria-label': t('rework.prompt'), spellcheck: 'false', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (view, event) => {
        const file = latest.current.resolvePastedImage && event.clipboardData
          ? latest.current.resolvePastedImage({ clipboardData: event.clipboardData, nativeEvent: event })
          : Array.from(event.clipboardData?.files ?? []).find((entry) => entry.type.startsWith('image/'));
        if (!file || !latest.current.onPasteImage) return false;
        event.preventDefault();
        const original = editorRef.current; if (!original) return true;
        const id = Symbol('paste');
        pasteAnchors.current.set(id, { editor: original, key: latest.current.draft.key, position: view.state.selection.from });
        void latest.current.onPasteImage(file).then((token) => {
          const anchor = pasteAnchors.current.get(id); pasteAnchors.current.delete(id);
          if (!token || !anchor || anchor.editor.isDestroyed || editorRef.current !== anchor.editor || latest.current.draft.key !== anchor.key) return;
          anchor.editor.commands.insertContentAt(anchor.position, [{ type: 'promptReference', attrs: { token, title: latest.current.references.find((entry) => entry.token === token)?.title ?? token } }, { type: 'text', text: ' ' }]);
          latest.current.draft.flush(anchor.editor.getText({ blockSeparator: '\n' }));
        }, (cause: unknown) => {
          const anchor = pasteAnchors.current.get(id); pasteAnchors.current.delete(id);
          if (anchor?.editor === editorRef.current && latest.current.draft.key === anchor.key) setError(cause instanceof Error ? cause.message : String(cause));
        });
        return true;
      },
      handleKeyDown: (view, event) => {
        event.stopPropagation();
        if (event.isComposing || view.composing) return false;
        if (pickerRef.current?.kind === 'reference') {
          const choices = latest.current.pickable.filter((entry) => `${entry.label} ${entry.title}`.toLowerCase().includes(searchRef.current.toLowerCase()));
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveOption((old) => choices.length ? (old + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0); return true; }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); const choice=choices[activeOptionRef.current]; if(choice) pickReferenceRef.current(choice); return true; }
          if (event.key === 'Escape') { event.preventDefault(); setPicker(null); return true; }
          return false;
        }
        if (pickerRef.current?.kind === 'slash') {
          const choices = latest.current.slashCommands?.filter(entry => `${entry.label} ${entry.hint ?? ''}`.toLowerCase().includes(searchRef.current.toLowerCase())) ?? [];
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveOption(old => choices.length ? (old + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0); return true; }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); const choice = choices[activeOptionRef.current]; if (choice) runSlashRef.current(choice); return true; }
          if (event.key === 'Escape') { event.preventDefault(); setPicker(null); return true; }
          return false;
        }
        if (event.key === 'Enter' && !event.shiftKey && (latest.current.submitOnEnter || event.metaKey || event.ctrlKey)) {
          event.preventDefault(); latest.current.draft.flush(editorRef.current?.getText({ blockSeparator: '\n' }) ?? ''); latest.current.onSubmit(); return true;
        }
        return false;
      },
    },
    onTransaction: ({ editor, transaction }) => {
      for (const anchor of pasteAnchors.current.values()) if (anchor.editor === editor) anchor.position = transaction.mapping.map(anchor.position);
    },
    onUpdate: ({ editor }) => { if (editor === editorRef.current && latest.current.draft.key === ownerKey) { latest.current.draft.set(editor.getText({ blockSeparator: '\n' })); refreshReferencePicker(editor); } },
    onSelectionUpdate: ({ editor }) => { if (!pickerRef.current || pickerRef.current.kind === 'reference' || pickerRef.current.typed) refreshReferencePicker(editor); },
    onBlur: ({ editor }) => { if (editor === editorRef.current && latest.current.draft.key === ownerKey && !editor.isDestroyed && editor.schema) latest.current.draft.flush(editor.getText({ blockSeparator: '\n' })); },
  }, [ownerKey]);
  const editorRef = useRef(editor); editorRef.current = editor;
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.schema || editor.view.composing) return;
    const normalized = normalizeReferenceTriggers(props.draft.value, props.references);
    if (normalized !== props.draft.value) latest.current.draft.flush(normalized);
    const text = editor.getText({ blockSeparator: '\n' });
    const changedReferences = previousReferences.current !== referenceSignature;
    if (text !== props.draft.value || changedReferences) {
      if (text !== props.draft.value) pasteAnchors.current.clear();
      const from = promptTextOffset(editor.state.doc, editor.state.selection.from);
      const to = promptTextOffset(editor.state.doc, editor.state.selection.to);
      editor.chain().setMeta('addToHistory', false).setContent(promptDocument(props.draft.value, props.references), { emitUpdate: false }).run();
      if (text === props.draft.value) editor.commands.setTextSelection({ from: promptPositionAtOffset(editor.state.doc, from), to: promptPositionAtOffset(editor.state.doc, to) });
    }
    previousReferences.current = referenceSignature;
  }, [editor, props.draft.value, referenceSignature, compositionVersion]);
  useEffect(() => { setPicker(null); setError(''); pasteAnchors.current.clear(); }, [ownerKey]);
  useEffect(() => () => { pasteAnchors.current.clear(); }, []);
  useEffect(() => { if (props.autoFocus) editor?.commands.focus('end'); }, [editor, props.autoFocus]);
  const pickReference = (reference: ComposerReference) => {
    if (!editor || !picker) return;
    editor.chain().focus().insertContentAt({ from: picker.position, to: picker.end ?? picker.position }, [{ type: 'promptReference', attrs: { token: reference.token, title: reference.title, source: reference.displayUrl ?? '' } }, { type: 'text', text: ' ' }]).run();
    latest.current.draft.flush(editor.getText({ blockSeparator: '\n' })); setPicker(null);
  };
  pickReferenceRef.current = pickReference;
  const lastPickerRequest = useRef(props.referencePickerRequest);
  useEffect(() => {
    if (!editor || lastPickerRequest.current === props.referencePickerRequest) return;
    lastPickerRequest.current = props.referencePickerRequest;
    editor.commands.focus();
    if (!pickerRef.current) editor.commands.insertContent('@');
    refreshReferencePicker(editor);
  }, [editor, props.referencePickerRequest]);
  const lastSlashRequest = useRef(props.slashPickerRequest);
  useEffect(() => {
    if (!editor || lastSlashRequest.current === props.slashPickerRequest) return;
    lastSlashRequest.current = props.slashPickerRequest;
    const rect = editor.view.dom.getBoundingClientRect();
    setSearch(''); setActiveOption(0);
    setPicker({ kind: 'slash', position: editor.state.selection.from, anchor: anchorToElement(editor.view.dom, { x: rect.left, y: rect.top - 8, placement: 'above', flipY: rect.bottom + 8 }) });
  }, [editor, props.slashPickerRequest]);
  const runSlash = (command: SlashCommand) => {
    if (!editor || !picker) return;
    setPicker(null); pickerRef.current = null;
    if (picker.typed) editor.commands.deleteRange({ from: picker.position, to: picker.end ?? picker.position });
    latest.current.draft.flush(editor.getText({ blockSeparator: '\n' }));
    command.run();
    if (command.focusEditor !== false) editor.commands.focus();
  };
  runSlashRef.current = runSlash;
  const commands = props.slashCommands?.filter((entry) => `${entry.label} ${entry.hint ?? ''}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const references = props.pickable.filter((entry) => `${entry.label} ${entry.title}`.toLowerCase().includes(search.toLowerCase()));
  const content = <EditorContent editor={editor} className={`studio-prompt-editor ${expanded ? 'is-expanded' : ''}`} onCompositionEnd={() => queueMicrotask(() => { setCompositionVersion((value) => value + 1); if (editor) refreshReferencePicker(editor); })} onPointerDown={(event) => event.stopPropagation()} />;
  return <div className="composer-prompt relative min-w-0 flex-1">
    {props.sourceChip && <span className="composer-source-chip">{props.sourceChip.label}<button type="button" aria-label={t('rework.canvas.composer.clearSource')} onClick={props.sourceChip.onClear}><X /></button></span>}
    <button type="button" className="composer-expand" title={t('ui.workbench.expandPrompt')} aria-label={t('ui.workbench.expandPrompt')} onClick={() => setExpanded(true)}><Maximize2 size={14} /></button>
    {!expanded && content}
    <UiModal isOpen={expanded} title={t('rework.prompt')} onClose={() => setExpanded(false)} widthClassName="w-[min(900px,calc(100vw-2rem))]" footer={<UiButton variant="primary" onClick={() => setExpanded(false)}>{t('common.confirm')}</UiButton>}>{expanded && content}</UiModal>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {picker && <MenuSurface anchor={picker.anchor} width={320} label={t(picker.kind === 'reference' ? 'rework.references' : 'rework.canvas.composer.functions')} onClose={() => setPicker(null)}>
      <MenuLabel>{t(picker.kind === 'reference' ? 'rework.references' : 'rework.canvas.composer.functions')}</MenuLabel>
      {picker.kind === 'slash' && !picker.typed && <label className="ui-menu__search"><Search size={14} /><input autoFocus value={search} aria-label={t('rework.search')} placeholder={t('rework.search')} onChange={(event) => { setSearch(event.target.value); setActiveOption(0); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setActiveOption(old => commands.length ? (old + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length : 0); } else if (event.key === 'Enter') { event.preventDefault(); if (commands[activeOption]) runSlash(commands[activeOption]); } }} /></label>}
      <div className="ui-scrollbar max-h-72 overflow-y-auto">{picker.kind === 'reference' ? references.map((entry, index) => <button role="option" aria-selected={index === activeOption} data-active={index === activeOption || undefined} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveOption(index)} type="button" key={`${entry.sourceNodeId}:${entry.token}`} className="ui-menu__item" onClick={() => pickReference(entry)}><span className="ui-menu__icon">{referenceIcon(entry)}</span><span className="ui-menu__label"><span>{entry.label}</span><span className="ui-menu__hint">{entry.title}</span></span></button>) : commands.map((entry, index) => <button type="button" role="menuitem" key={entry.id} data-active={index === activeOption || undefined} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveOption(index)} className="ui-menu__item" onClick={() => runSlash(entry)}><span className="ui-menu__icon">{entry.icon ?? <AtSign />}</span><span className="ui-menu__label"><span>{entry.label}</span><span className="ui-menu__hint line-clamp-2">{entry.hint}</span></span></button>)}
      {picker.kind === 'slash' && <div className="px-3 py-2 text-[11px] text-text-subtle">{t('ui.canvas.slashKeys')}</div>}
      {!(picker.kind === 'reference' ? references.length : commands.length) && <p className="px-3 py-5 text-xs text-text-muted">{t(picker.kind === 'reference' ? 'ui.workbench.noReferences' : 'rework.noMatches')}</p>}
      {picker.kind === 'reference' && <div className="composer-mention-actions">{props.onUploadReference && <button type="button" onClick={() => { setPicker(null); props.onUploadReference?.(); }}>上传本地素材</button>}{props.onChooseAsset && <button type="button" onClick={() => { setPicker(null); props.onChooseAsset?.(); }}>从资产中选择</button>}<span>↑↓ 选择 · Enter 引用 · Esc 关闭</span></div>}</div>
    </MenuSurface>}
  </div>;
}
