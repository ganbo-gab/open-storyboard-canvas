import { ParameterSchemaEditor } from './ParameterSchemaEditor';
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";

import { UiButton, UiIconButton, UiInput, UiSelect } from "@/components/ui";
import { operationKinds, type ModeSpec, type ModelSpec, type OperationKind, type ParamSpec, type RefSlot } from "@/features/channels/domain/profile";

const MODE_OPERATIONS = operationKinds.filter((kind) => kind !== "models.list");
const FIELD = "h-8 min-w-0 px-2 text-xs";

type Props = { model: ModelSpec; onChange: (model: ModelSpec) => void };

/**
 * Manual DIY editor for one model's modes: each mode picks its operation and
 * declares exactly the parameters (basic / advanced) and reference slots it
 * accepts. Endpoint overrides stay in the JSON editor; the request preview
 * shows the effect of every change before saving.
 */
export function ModelModesEditor({ model, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(model.modes?.[0]?.id ?? null);
  const modes = model.modes ?? [];
  const setModes = (next: ModeSpec[]) => onChange({ ...model, modes: next.length ? next : undefined });
  const patchMode = (index: number, patch: Partial<ModeSpec>) => setModes(modes.map((mode, i) => (i === index ? { ...mode, ...patch } : mode)));

  const addMode = () => {
    const id = `mode${modes.length + 1}`;
    // The first explicit mode inherits the legacy single-mode contract so nothing is silently lost.
    const legacySlots: RefSlot[] = modes.length ? [] : (["image", "video", "audio"] as const).flatMap((kind) => {
      const max = model.refs?.[kind] ?? 0;
      return max > 0 ? [{ key: kind, label: t(`channelModes.editor.kind.${kind}`), kind, max }] : [];
    });
    setModes([...modes, { id, label: t("channelModes.editor.newMode", { index: modes.length + 1 }), operation: model.operations.find((op) => op !== "models.list") ?? "video.generate", slots: legacySlots }]);
    setOpen(id);
  };

  return (
    <div className="space-y-2 rounded-md border border-[var(--line)] bg-bg p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] leading-4 text-text-subtle">{modes.length ? t("channelModes.editor.hint") : t("channelModes.editor.legacy")}</p>
        <UiButton variant="ghost" size="sm" icon={<Plus />} onClick={addMode}>{t("channelModes.editor.addMode")}</UiButton>
      </div>
      <ParameterSchemaEditor key={`${model.id}:common`} title="公共工作台参数" params={model.params} onChange={(params) => onChange({ ...model, params })} />
      {modes.map((mode, index) => {
        const expanded = open === mode.id;
        const params = mode.params ?? [];
        const slots = mode.slots ?? [];
        const setParams = (next: ParamSpec[]) => patchMode(index, { params: next.length ? next : undefined });
        const setSlots = (next: RefSlot[]) => patchMode(index, { slots: next.length ? next : undefined });
        return (
          <div key={index} className="rounded-md border border-[var(--line)] bg-surface">
            <div className="flex items-center gap-1.5 p-2">
              <UiIconButton size="sm" aria-label={mode.label} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : mode.id)}>
                {expanded ? <ChevronDown /> : <ChevronRight />}
              </UiIconButton>
              <UiInput aria-label={t("channelModes.editor.label")} value={mode.label} onChange={(event) => patchMode(index, { label: event.target.value })} className={`${FIELD} flex-1`} />
              <UiInput aria-label={t("channelModes.editor.id")} value={mode.id} onChange={(event) => { if (open === mode.id) setOpen(event.target.value); patchMode(index, { id: event.target.value }); }} className={`${FIELD} w-28 font-mono`} />
              <UiSelect aria-label={t("channelModes.editor.operation")} disabled={Boolean(mode.endpoint)} title={mode.endpoint ? t("ui.channels.manage.endpointBound") : undefined} value={mode.operation} onChange={(event) => patchMode(index, { operation: event.target.value as OperationKind })} className="h-8 w-36 text-xs">
                {MODE_OPERATIONS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </UiSelect>
              <UiIconButton size="sm" aria-label={t("rework.delete")} className="hover:text-danger" onClick={() => setModes(modes.filter((_, i) => i !== index))}><X /></UiIconButton>
            </div>
            {expanded ? (
              <div className="space-y-3 border-t border-[var(--line)] p-2.5">
                {mode.endpoint && <p className="text-xs leading-5 text-text-muted">{t("ui.channels.manage.endpointBound")}</p>}
                <UiInput aria-label={t("channelModes.editor.description")} placeholder={t("channelModes.editor.description")} value={mode.description ?? ""}
                  onChange={(event) => patchMode(index, { description: event.target.value || undefined })} className={`${FIELD} w-full`} />

                <section className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-medium text-text-muted">
                    {t("channelModes.editor.slots")}
                    <UiButton variant="ghost" size="sm" icon={<Plus />} onClick={() => setSlots([...slots, { key: `slot${slots.length + 1}`, label: t("channelModes.editor.kind.image"), kind: "image", max: 1 }])}>{t("channelModes.editor.addSlot")}</UiButton>
                  </div>
                  {slots.map((slot, slotIndex) => {
                    const patchSlot = (patch: Partial<RefSlot>) => setSlots(slots.map((entry, i) => (i === slotIndex ? { ...entry, ...patch } : entry)));
                    return (
                      <div key={slotIndex} className="grid grid-cols-[1fr_1fr_88px_56px_56px_28px] items-center gap-1.5">
                        <UiInput aria-label={t("channelModes.editor.slotKey")} value={slot.key} onChange={(event) => patchSlot({ key: event.target.value })} className={`${FIELD} font-mono`} />
                        <UiInput aria-label={t("channelModes.editor.label")} value={slot.label} onChange={(event) => patchSlot({ label: event.target.value })} className={FIELD} />
                        <UiSelect aria-label={t("channelModes.editor.kindLabel")} value={slot.kind} onChange={(event) => patchSlot({ kind: event.target.value as RefSlot["kind"] })} className="h-8 text-xs">
                          {(["image", "video", "audio"] as const).map((kind) => <option key={kind} value={kind}>{t(`channelModes.editor.kind.${kind}`)}</option>)}
                        </UiSelect>
                        <UiInput aria-label={t("channelModes.editor.min")} type="number" min={0} value={slot.min ?? 0} onChange={(event) => patchSlot({ min: Number(event.target.value) || undefined })} className={FIELD} />
                        <UiInput aria-label={t("channelModes.editor.max")} type="number" min={0} value={slot.max} onChange={(event) => patchSlot({ max: Math.max(0, Number(event.target.value) || 0) })} className={FIELD} />
                        <UiIconButton size="sm" aria-label={t("rework.delete")} className="hover:text-danger" onClick={() => setSlots(slots.filter((_, i) => i !== slotIndex))}><X /></UiIconButton>
                      </div>
                    );
                  })}
                </section>

                <ParameterSchemaEditor key={`${model.id}:${mode.id}`} title="此模式的工作台参数" params={params} onChange={setParams} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
