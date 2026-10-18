import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UiInput } from "@/components/ui";
import type {
  ChannelProfileV2,
  OperationKind,
} from "@/features/channels/domain/profile";
import { previewChannel } from "@/features/channels/application/channelService";

type Props = { profile: ChannelProfileV2 };
export function ChannelRequestPreview({ profile }: Props) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState("");
  const [operation, setOperation] = useState<OperationKind>("image.generate");
  const [prompt, setPrompt] = useState("A quiet cinematic scene");
  const model =
    profile.models.find((item) => item.id === modelId) ?? profile.models[0];
  const selectedOperation = model?.operations.includes(operation)
    ? operation
    : model?.operations[0];
  const preview = useMemo(() => {
    if (!model || !selectedOperation) return t("rework.channels.missingModel");
    try {
      return JSON.stringify(
        previewChannel(profile, {
          jobId: "preview",
          channelId: profile.id,
          modelId: model.id,
          operation: selectedOperation,
          prompt,
          params: {},
          refs: [],
          count: 1,
        }),
        null,
        2,
      );
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }, [profile, model, selectedOperation, prompt, t]);
  return (
    <aside className="min-w-0 rounded-xl border border-border-dark bg-bg-dark/40 p-4">
      <h3 className="mb-4 text-xs font-semibold text-text-dark">
        {t("rework.channels.review")}
      </h3>
      <div className="mb-3 grid gap-2">
        <select
          aria-label={t("rework.model")}
          value={model?.id ?? ""}
          onChange={(event) => setModelId(event.target.value)}
          className="h-9 w-full rounded-lg border border-border-dark bg-surface-dark px-2 text-xs text-text-dark"
        >
          {profile.models.map((item, index) => (
            <option key={index} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
        <select
          aria-label={t("rework.channels.operation")}
          value={selectedOperation ?? ""}
          onChange={(event) =>
            setOperation(event.target.value as OperationKind)
          }
          className="h-9 rounded-lg border border-border-dark bg-surface-dark px-2 text-xs text-text-dark"
        >
          {model?.operations.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
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
        <details className="mt-4 border-t border-border-dark pt-3">
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
