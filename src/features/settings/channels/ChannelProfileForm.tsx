import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus, Save, X } from "lucide-react";
import { UiButton, UiInput, UiTextArea } from "@/components/ui";
import type { ChannelProfileV2 } from "@/features/channels/domain/profile";
import { parseProfileImport } from "@/features/channels/application/channelService";

type Props = {
  draft: ChannelProfileV2;
  onChange: (profile: ChannelProfileV2) => void;
  credential: string;
  onCredential: (key: string) => void;
  editing: boolean;
  busy: boolean;
  onSave: () => void;
  onTest: () => void;
  onError: (error: string) => void;
};
export function ChannelProfileForm({
  draft,
  onChange,
  credential,
  onCredential,
  editing,
  busy,
  onSave,
  onTest,
  onError,
}: Props) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const [source, setSource] = useState("");
  return (
    <div className="space-y-4">
      <label className="block text-xs text-text-muted">
        {t("rework.name")}
        <UiInput
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="mt-1.5"
        />
      </label>
      <label className="block text-xs text-text-muted">
        {t("rework.channels.baseUrl")}
        <UiInput
          value={draft.baseUrl}
          onChange={(event) =>
            onChange({
              ...draft,
              baseUrl: event.target.value.replace(/\/+$/, ""),
            })
          }
          className="mt-1.5 font-mono text-xs"
        />
      </label>
      <label className="block text-xs text-text-muted">
        {t("rework.channels.key")}
        <UiInput
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => onCredential(event.target.value)}
          className="mt-1.5 font-mono"
          placeholder={editing ? "••••••••" : ""}
        />
        <span className="mt-1 block text-[11px] leading-5">
          {t("rework.channels.keyHint")}
        </span>
      </label>
      <div>
        <p className="mb-2 text-xs text-text-muted">
          {t("rework.channels.models")}
        </p>
        {draft.models.map((model, index) => (
          <div key={index} className="mb-2 flex items-center gap-2">
            <UiInput
              aria-label={`${t("rework.model")} ${index + 1}`}
              value={model.id}
              onChange={(event) =>
                onChange({
                  ...draft,
                  models: draft.models.map((item, i) =>
                    i === index
                      ? {
                          ...item,
                          id: event.target.value,
                          label: event.target.value,
                        }
                      : item,
                  ),
                })
              }
              className="min-w-0 font-mono text-xs"
            />
            <span className="max-w-24 truncate text-[10px] text-text-muted">
              {model.operations.join(", ")}
            </span>
            <button
              type="button"
              aria-label={t("rework.delete")}
              onClick={() =>
                onChange({
                  ...draft,
                  models: draft.models.filter((_, i) => i !== index),
                })
              }
              className="p-2 text-text-muted hover:text-red-400"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const template =
              draft.models.find((model) =>
                model.operations.includes("image.generate"),
              ) ?? draft.models[0];
            if (template)
              onChange({
                ...draft,
                models: [
                  ...draft.models,
                  { ...structuredClone(template), id: "", label: "" },
                ],
              });
          }}
          className="flex items-center gap-1 py-1 text-xs text-accent"
        >
          <Plus className="h-3 w-3" />
          {t("rework.channels.new")}
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          setAdvanced(!advanced);
          setSource(JSON.stringify(draft, null, 2));
        }}
        className="text-xs text-text-muted underline underline-offset-4"
      >
        {t("rework.channels.advanced")}
      </button>
      {advanced && (
        <>
          <UiTextArea
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="min-h-64 font-mono text-[11px]"
          />
          <UiButton
            onClick={() => {
              const result = parseProfileImport(source);
              if (result.ok) {
                onChange(result.profile);
                onError("");
              } else
                onError(
                  result.errors
                    .map((item) => `${item.path}: ${item.message}`)
                    .join("\n"),
                );
            }}
          >
            {t("rework.channels.validate")}
          </UiButton>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <UiButton variant="primary" onClick={onSave}>
          <Save className="mr-2 h-4 w-4" />
          {t("rework.channels.save")}
        </UiButton>
        <UiButton
          disabled={busy || !draft.operations["models.list"]}
          onClick={onTest}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-2 h-4 w-4" />
          )}
          {t("rework.channels.test")}
        </UiButton>
      </div>
      <p className="text-[11px] text-text-muted">
        {t("rework.channels.testHint")}
      </p>
    </div>
  );
}
