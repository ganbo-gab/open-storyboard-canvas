import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AtSign, BookOpen, Settings2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { listSkillsForSurface, type SkillPickerItem } from "@/features/canvas/agent/application/agentSkills";
import { useAgentSkillStore } from "@/features/canvas/agent/application/userSkills";
import { listAgentMentionCandidates, resolveAgentMentions, type AgentMentionCandidate } from "@/features/canvas/agent/application/agentMentions";
import type { AgentScope, AgentTurnMediaInput } from "@/features/canvas/agent/domain/agentModel";
import { AssetMedia } from "@/features/assets/ui/AssetMedia";
import { SkillManagerDialog } from "./SkillDialogs";
import { UiInput } from "@/components/ui";
import { useAgentSkillRecencyStore } from "../application/agentSkillRecency";
import { requestStudioPageNavigation } from "@/features/studio/studioNavigation";

type Trigger = { kind: "skill" | "mention"; start: number; query: string };
const MAX_ITEMS = 40;

/** `/` and `@` open only at a token start, so paths ("a/b") and e-mail addresses never trigger. */
function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)([/@])([^\s/@]{0,40})$/.exec(before);
  if (!match) return null;
  return { kind: match[2] === "/" ? "skill" : "mention", start: before.length - match[3].length - 1, query: match[3] };
}

export interface AgentComposerAssist {
  explicitSkillIds: string[];
  /** Call from the textarea's onKeyDown first; `true` means the event was consumed by the picker. */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** Call after text/caret changes (onChange, onSelect/onClick). */
  sync(): void;
  toggleSkills(): void;
  skillsOpen: boolean;
  /** Absolutely positioned above the composer; render inside a `relative` container. */
  popover: ReactNode;
  chips: ReactNode;
  dialogs: ReactNode;
  /** Resolve `@` tokens into turn media and appended context lines. */
  prepare(message: string): Promise<{ message: string; media: AgentTurnMediaInput[] }>;
  /** Record only after a turn used the skills, not while browsing or drafting a local plan. */
  markSent(skillIds?: readonly string[]): void;
  reset(): void;
}

/** Shared `/` skill picker and `@` mention panel for the home, canvas and stage Agent composers. */
export function useAgentComposerAssist({ scope, projectId, text, setText, textareaRef }: {
  scope: AgentScope;
  projectId?: string;
  text: string;
  setText(value: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): AgentComposerAssist {
  const { t } = useTranslation();
  const userSkills = useAgentSkillStore((state) => state.skills);
  const skillsReady = useAgentSkillStore((state) => state.initialized);
  const recentIds = useAgentSkillRecencyStore(state => state.recentBySurface[scope]);
  const [recencyError, setRecencyError] = useState("");
  const [skillError, setSkillError] = useState("");
  useEffect(() => { void useAgentSkillRecencyStore.getState().initialize().catch((cause: unknown) => setRecencyError(cause instanceof Error ? cause.message : String(cause))); }, []);
  useEffect(() => { void useAgentSkillStore.getState().initialize().catch((cause: unknown) => setSkillError(cause instanceof Error ? cause.message : String(cause))); }, []);
  // listSkillsForSurface reads the skill store; re-list when user skills change.
  const skills = useMemo(() => (skillsReady ? listSkillsForSurface(scope) : []), [scope, skillsReady, userSkills]);
  const [selected, setSelected] = useState<string[]>([]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [skillPanel, setSkillPanel] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [candidates, setCandidates] = useState<AgentMentionCandidate[] | null>(null);
  const [mentionError, setMentionError] = useState("");
  const [active, setActive] = useState(0);
  const [manager, setManager] = useState(false);
  const mentionOpen = trigger?.kind === "mention";
  useEffect(() => {
    if (!mentionOpen) return;
    let alive = true;
    setMentionError("");
    void listAgentMentionCandidates({ scope, projectId }).then(
      (list) => { if (alive) setCandidates(list); },
      (cause: unknown) => { if (alive) { setCandidates([]); setMentionError(cause instanceof Error ? cause.message : String(cause)); } },
    );
    return () => { alive = false; };
  }, [mentionOpen, scope, projectId]);
  const open: Trigger["kind"] | null = trigger?.kind ?? (skillPanel ? "skill" : null);
  const query = (trigger?.query ?? (open === "skill" ? skillSearch : "")).toLocaleLowerCase();
  const availableSkills = open === "skill" ? skills.filter(skill => !selected.includes(skill.id) && `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query)) : [];
  const recentSkills = query ? [] : recentIds.flatMap(id => availableSkills.find(skill => skill.id === id) ?? []);
  const skillItems: SkillPickerItem[] = open === "skill"
    ? [...recentSkills, ...availableSkills.filter(skill => !recentSkills.some(recent => recent.id === skill.id))].slice(0, MAX_ITEMS)
    : [];
  const mentionItems: AgentMentionCandidate[] = open === "mention"
    ? (candidates ?? []).filter((candidate) => candidate.label.toLocaleLowerCase().includes(query)).slice(0, MAX_ITEMS)
    : [];
  const count = open === "skill" ? skillItems.length : mentionItems.length;
  const close = () => { setTrigger(null); setSkillPanel(false); };
  const replaceTrigger = (insert: string) => {
    const element = textareaRef.current;
    if (!trigger) return;
    const caret = element?.selectionStart ?? text.length;
    setText(text.slice(0, trigger.start) + insert + text.slice(caret));
    const position = trigger.start + insert.length;
    setTrigger(null);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(position, position); });
  };
  const pickSkill = (skill: SkillPickerItem) => {
    setSelected((current) => (current.includes(skill.id) ? current : [...current, skill.id]));
    if (trigger) replaceTrigger("");
    else requestAnimationFrame(() => textareaRef.current?.focus());
    setSkillPanel(false);
  };
  const pickMention = (candidate: AgentMentionCandidate) => replaceTrigger(`${candidate.token} `);
  const sync = () => {
    const element = textareaRef.current;
    if (!element) return;
    const next = detectTrigger(element.value, element.selectionStart ?? element.value.length);
    setTrigger((current) => (current?.kind === next?.kind && current?.start === next?.start && current?.query === next?.query ? current : next));
    setActive(0);
    if (next) setSkillPanel(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); close(); return true; }
    if (!count) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      const index = Math.min(active, count - 1);
      if (open === "skill") pickSkill(skillItems[index]);
      else pickMention(mentionItems[index]);
      return true;
    }
    return false;
  };
  const prepare = async (message: string) => {
    if (!message.includes("@")) return { message, media: [] };
    const resolved = await resolveAgentMentions(message, await listAgentMentionCandidates({ scope, projectId }));
    return {
      message: resolved.contextLines.length ? `${message}\n\n${resolved.contextLines.join("\n")}` : message,
      media: resolved.media,
    };
  };
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const popover = open ? (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[12px] border border-[var(--line)] bg-(--ui-surface-panel) shadow-[var(--shadow-float)]">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-[11px] text-text-muted">
        {open === "skill" ? <BookOpen className="h-3.5 w-3.5" /> : <AtSign className="h-3.5 w-3.5" />}
        <span className="flex-1">{t(open === "skill" ? "rework.skills.pickerTitle" : "rework.mentions.title")}</span>
        {open === "skill" && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--hover)] hover:text-text-dark" onClick={() => { close(); setManager(true); }}>
            <Settings2 className="h-3 w-3" />{t("rework.skills.manage")}
          </button>
        )}
      </div>
      {open === "skill" && <div className="border-b border-[var(--line)] p-2"><UiInput
        aria-label={t("rework.skills.search")} placeholder={t("rework.skills.search")} value={trigger?.query ?? skillSearch}
        onChange={event => { setSkillSearch(event.target.value); setTrigger(current => current?.kind === "skill" ? { ...current, query: event.target.value } : current); setActive(0); }}
        onKeyDown={onKeyDown} className="h-8 w-full text-xs" /></div>}
      <div role="listbox" aria-label={t(open === "skill" ? "rework.skills.pickerTitle" : "rework.mentions.title")} className="ui-scrollbar max-h-64 overflow-y-auto p-1">
        {open === "skill" && skillItems.map((skill, index) => (
          <Fragment key={skill.id}>
          {!query && (index === 0 || index === recentSkills.length) && <p role="presentation" className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-text-subtle">{t(recentSkills.length && index < recentSkills.length ? "rework.skills.recent" : "rework.skills.all")}</p>}
          <button type="button" role="option" aria-selected={index === active}
            className="flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left aria-selected:bg-[var(--hover)]"
            onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => pickSkill(skill)}>
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text-dark">{skill.name}{skill.source === "user" ? ` · ${t("rework.skills.mine")}` : ""}</span>
              <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-text-muted">{skill.description}</span>
            </span>
          </button>
          </Fragment>
        ))}
        {open === "mention" && mentionItems.map((candidate, index) => (
          <button key={candidate.id} type="button" role="option" aria-selected={index === active}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left aria-selected:bg-[var(--hover)]"
            onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => pickMention(candidate)}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-[var(--field-bg)] text-text-muted">
              {candidate.thumbnail ? <AssetMedia source={candidate.thumbnail} kind="image" alt="" className="h-full w-full object-cover" /> : <AtSign className="h-3.5 w-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-text-dark">{candidate.label}</span>
              <span className="block truncate text-[10.5px] text-text-muted">{t(`rework.mentions.kinds.${candidate.kind}`)}</span>
            </span>
          </button>
        ))}
        {!count && (
          <p className="px-3 py-4 text-center text-[11px] text-text-muted">
            {open === "mention"
              ? (mentionError || (candidates === null ? t("common.loading") : t("rework.mentions.empty")))
              : (skillError || (!skillsReady ? t("common.loading") : t("rework.skills.noMatches")))}
          </p>
        )}
      </div>
      {open === "mention" && <div className="border-t border-[var(--line)] px-3 py-2"><button type="button" className="text-[11px] text-accent hover:underline" onClick={() => { close(); requestStudioPageNavigation("characters"); }}>{t("rework.mentions.manageCharacters")}</button></div>}
    </div>
  ) : null;
  const chips = <>
    {selected.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t("rework.skills.selected")}>
      {selected.map((id) => (
        <span key={id} className="flex items-center gap-1 rounded-full border border-accent/25 bg-accent/[0.08] py-0.5 pl-2 pr-0.5 text-[11px] text-text-dark">
          <Sparkles className="h-3 w-3 text-accent" />
          {skillById.get(id)?.name ?? id}
          <button type="button" aria-label={t("rework.skills.remove", { name: skillById.get(id)?.name ?? id })}
            className="rounded-full p-0.5 hover:bg-[var(--hover)]" onClick={() => setSelected((current) => current.filter((entry) => entry !== id))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
    }
    {recencyError && <p role="status" className="mb-2 text-[10.5px] text-warning">{t("rework.skills.recencyFailed")}</p>}
  </>;
  return {
    explicitSkillIds: selected,
    onKeyDown,
    sync,
    toggleSkills: () => { setTrigger(null); setSkillSearch(""); setActive(0); setSkillPanel((current) => !current); },
    skillsOpen: open === "skill",
    popover,
    chips,
    dialogs: manager ? <SkillManagerDialog onClose={() => setManager(false)} /> : null,
    prepare,
    markSent: (skillIds = selected) => {
      void useAgentSkillRecencyStore.getState().recordUse(scope, skillIds).then(
        () => setRecencyError(""),
        (cause: unknown) => setRecencyError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    reset: () => { setSelected([]); close(); },
  };
}

/** Merge resolved mention media into explicit attachments without duplicating an asset. */
export function mergeTurnMedia(attachments: readonly AgentTurnMediaInput[], mentioned: readonly AgentTurnMediaInput[]): AgentTurnMediaInput[] {
  const seen = new Set(attachments.map((item) => item.assetId));
  return [...attachments, ...mentioned.filter((item) => !seen.has(item.assetId) && seen.add(item.assetId))];
}
