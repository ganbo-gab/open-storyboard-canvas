import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UiInput, UiSelect } from "@/components/ui";
import type {
  ChannelProfileV2,
  OperationKind,
} from "@/features/channels/domain/profile";
import { previewChannel } from "@/features/channels/application/channelService";
import { modeParamDefaults, resolveModelModeOrFirst } from "@/features/channels/application/modelModes";
import type { JobRef } from "@/features/channels/runtime/types";

const SAMPLE_MIME = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" } as const;

type Props = { profile: ChannelProfileV2 };
export function ChannelRequestPreview({ profile }: Props) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState("");
  const [operation, setOperation] = useState<OperationKind>("image.generate");
  const [modeId, setModeId] = useState("");
  const [prompt, setPrompt] = useState("A quiet cinematic scene");
  const model =
    profile.models.find((item) => item.id === modelId) ?? profile.models[0];
  // Mode models preview one declared mode: its operation, its defaults and sample media for every required slot.
  const mode = model?.modes?.length ? resolveModelModeOrFirst(model, modeId) : null;
  const selectedOperation = mode
    ? mode.operation
    : model?.operations.includes(operation)
      ? operation
      : model?.operations[0];
  const preview = useMemo(() => {
    if (!model || !selectedOperation) return t("rework.channels.missingModel");
    const refs: JobRef[] = mode
      ? mode.slots.flatMap((slot) => Array.from({ length: Math.max(slot.min ?? 0, slot.max > 0 ? 1 : 0) }, (_, index) => ({
        kind: slot.kind,
        slot: slot.key,
        assetId: `sample-${slot.key}-${index + 1}`,
        path: `https://example.com/sample-${slot.key}-${index + 1}.${slot.kind === "image" ? "png" : slot.kind === "video" ? "mp4" : "mp3"}`,
        mime: SAMPLE_MIME[slot.kind],
      })))
      : [];
    try {
      return JSON.stringify(
        previewChannel(profile, {
          jobId: "preview",
          channelId: profile.id,
          modelId: model.id,
          ...(mode ? { modeId: mode.mode.id } : {}),
          operation: selectedOperation,
          prompt,
          params: mode ? modeParamDefaults(mode) : {},
          refs,
          count: 1,
        }),
        null,
        2,
      );
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }, [profile, model, mode, selectedOperation, prompt, t]);
  return (
    <aside className="min-w-0 self-start rounded-[var(--r-lg)] border border-[var(--line)] bg-surface p-4 xl:sticky xl:top-0">
      <h3 className="mb-4 text-xs font-semibold text-text-dark">
        {t("rework.channels.review")}
      </h3>
      <div className="mb-3 grid gap-2">
        <UiSelect
          aria-label={t("rework.model")}
          value={model?.id ?? ""}
          onChange={(event) => setModelId(event.target.value)}
          className="text-xs"
        >
          {profile.models.map((item, index) => (
            <option key={index} value={item.id}>
              {item.id}
            </option>
          ))}
        </UiSelect>
        {mode && model?.modes ? (
          <UiSelect
            aria-label={t("channelModes.mode")}
            value={mode.mode.id}
            onChange={(event) => setModeId(event.target.value)}
            className="text-xs"
          >
            {model.modes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} · {entry.operation}
              </option>
            ))}
          </UiSelect>
        ) : (
          <UiSelect
            aria-label={t("rework.channels.operation")}
            value={selectedOperation ?? ""}
            onChange={(event) =>
              setOperation(event.target.value as OperationKind)
            }
            className="text-xs"
          >
            {model?.operations.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </UiSelect>
        )}
        <UiInput
          aria-label={t("rework.channels.samplePrompt")}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <pre className="ui-scrollbar max-h-[520px] overflow-auto whitespace-pre-wrap break-all text-[11px] leading-6 text-text-muted">
        {preview}
      </pre>
      {!!profile.notes?.length && (
        <details className="mt-4 border-t border-[var(--line)] pt-3">
          <summary className="cursor-pointer text-xs text-text-muted">
            {t("rework.channels.evidence")}
          </summary>
          <ul className="mt-2 space-y-2 text-[11px] leading-5 text-text-muted">
            {profile.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
