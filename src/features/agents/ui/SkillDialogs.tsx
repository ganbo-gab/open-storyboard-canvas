import { useEffect, useRef, useState } from "react";
import { Download, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ZodError } from "zod";
import { UiBadge, UiButton, UiChipButton, UiConfirm, UiField, UiIconButton, UiInput, UiModal, UiSelect, UiTextArea } from "@/components/ui";
import { listRegisteredAgentToolNames } from "@/features/agents/domain/agentToolNames";
import { useAgentSkillStore, type SkillDraft, type SkillSurface, type UserAgentSkill } from "@/features/canvas/agent/application/userSkills";

const SURFACES: readonly SkillSurface[] = ["all", "home", "canvas", "stage"];
const EMPTY_DRAFT: SkillDraft = { name: "", description: "", surface: "all", tools: [], instructions: "" };

export function skillErrorText(cause: unknown): string {
  if (cause instanceof ZodError) return cause.issues.map((issue) => `${issue.path.join(".") || "skill"}: ${issue.message}`).join("; ");
  return cause instanceof Error ? cause.message : String(cause);
}

/** Create or edit one user skill. Tools are an optional whitelist; none = no extra restriction. */
export function SkillEditorDialog({ initial, editingId, onClose, onSaved }: {
  initial?: SkillDraft;
  editingId?: string;
  onClose(): void;
  onSaved?(skill: UserAgentSkill): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SkillDraft>(() => structuredClone(initial ?? EMPTY_DRAFT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tools = listRegisteredAgentToolNames();
  const save = async () => {
    setBusy(true); setError("");
    try {
      const store = useAgentSkillStore.getState();
      const skill = editingId ? await store.update(editingId, draft) : await store.create(draft);
      onSaved?.(skill);
      onClose();
    } catch (cause) { setError(skillErrorText(cause)); }
    finally { setBusy(false); }
  };
  return (
    <UiModal
      isOpen
      title={t(editingId ? "rework.skills.editTitle" : "rework.skills.createTitle")}
      onClose={() => { if (!busy) onClose(); }}
      widthClassName="w-[min(640px,calc(100vw-1.5rem))]"
      footer={<>
        <UiButton variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</UiButton>
        <UiButton variant="primary" loading={busy} disabled={!draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()} onClick={() => void save()}>{t("common.save")}</UiButton>
      </>}
    >
      <div className="space-y-3">
        <UiField label={t("rework.skills.name")}>
          <UiInput value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </UiField>
        <UiField label={t("rework.skills.description")}>
          <UiInput value={draft.description} maxLength={1000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </UiField>
        <UiField label={t("rework.skills.surface")}>
          <UiSelect value={draft.surface} onChange={(event) => setDraft({ ...draft, surface: SURFACES.find((surface) => surface === event.target.value) ?? "all" })}>
            {SURFACES.map((surface) => <option key={surface} value={surface}>{t(`rework.skills.surfaces.${surface}`)}</option>)}
          </UiSelect>
        </UiField>
        <UiField label={t("rework.skills.tools")} hint={t("rework.skills.toolsHint")}>
          <div className="flex flex-wrap gap-1">
            {tools.map((tool) => {
              const on = draft.tools.includes(tool);
              return (
                <UiChipButton key={tool} active={on} aria-pressed={on} className="font-mono text-[10.5px]"
                  onClick={() => setDraft({ ...draft, tools: on ? draft.tools.filter((entry) => entry !== tool) : [...draft.tools, tool] })}>
                  {tool}
                </UiChipButton>
              );
            })}
          </div>
        </UiField>
        <UiField label={t("rework.skills.instructions")}>
          <UiTextArea value={draft.instructions} maxLength={18000} className="min-h-40 text-xs leading-5" onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
        </UiField>
        {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      </div>
    </UiModal>
  );
}

/** Browse, import, export, edit and delete user skills; built-in skills are read-only and not listed. */
export function SkillManagerDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const skills = useAgentSkillStore((state) => state.skills);
  const storageStatus = useAgentSkillStore((state) => state.storageStatus);
  const [editing, setEditing] = useState<UserAgentSkill | "new" | null>(null);
  const [removing, setRemoving] = useState<UserAgentSkill | null>(null);
  const [error, setError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void useAgentSkillStore.getState().initialize().catch((cause: unknown) => setError(skillErrorText(cause))); }, []);
  const exportSkill = (skill: UserAgentSkill) => {
    try {
      const url = URL.createObjectURL(new Blob([useAgentSkillStore.getState().exportMarkdown(skill.id)], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url; link.download = `${skill.name.replace(/[\\/:*?"<>|]+/g, "_")}.md`; link.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(skillErrorText(cause)); }
  };
  return (
    <>
      <UiModal
        isOpen
        title={t("rework.skills.manageTitle")}
        onClose={onClose}
        widthClassName="w-[min(680px,calc(100vw-1.5rem))]"
        footer={<>
          <UiButton variant="ghost" icon={<FileUp />} onClick={() => importInput.current?.click()}>{t("rework.skills.import")}</UiButton>
          <UiButton variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>{t("rework.skills.create")}</UiButton>
        </>}
      >
        <input ref={importInput} type="file" accept=".md,text/markdown,text/plain" hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setError("");
          void file.text().then((text) => useAgentSkillStore.getState().importMarkdown(text)).catch((cause: unknown) => setError(skillErrorText(cause)));
        }} />
        {storageStatus.mode === "memory" && <p role="alert" className="mb-3 text-xs text-warning">{t("rework.skills.memoryOnly")}</p>}
        {!skills.length && <p className="py-8 text-center text-xs text-text-muted">{t("rework.skills.empty")}</p>}
        <ul className="space-y-2">
          {skills.map((skill) => (
            <li key={skill.id} className="flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)] p-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-text-dark">
                  <span className="truncate">{skill.name}</span>
                  <UiBadge>{t(`rework.skills.surfaces.${skill.surface}`)}</UiBadge>
                  {skill.tools.length > 0 && <UiBadge tone="accent">{t("rework.skills.toolCount", { count: skill.tools.length })}</UiBadge>}
                </p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{skill.description}</p>
              </div>
              <UiIconButton aria-label={t("rework.skills.export")} title={t("rework.skills.export")} onClick={() => exportSkill(skill)}><Download /></UiIconButton>
              <UiIconButton aria-label={t("rework.skills.edit")} title={t("rework.skills.edit")} onClick={() => setEditing(skill)}><Pencil /></UiIconButton>
              <UiIconButton aria-label={t("rework.delete")} title={t("rework.delete")} onClick={() => setRemoving(skill)}><Trash2 /></UiIconButton>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="mt-3 break-words text-xs text-danger">{error}</p>}
      </UiModal>
      {editing && (
        <SkillEditorDialog
          initial={editing === "new" ? undefined : editing}
          editingId={editing === "new" ? undefined : editing.id}
          onClose={() => setEditing(null)}
        />
      )}
      <UiConfirm
        isOpen={!!removing}
        title={t("rework.skills.deleteTitle")}
        description={t("rework.skills.deleteConfirm", { name: removing?.name ?? "" })}
        confirmLabel={t("rework.delete")}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) void useAgentSkillStore.getState().remove(removing.id).catch((cause: unknown) => setError(skillErrorText(cause))); }}
      />
    </>
  );
}
