import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Save } from "lucide-react";
import { UiButton, UiInput, UiTextArea } from "@/components/ui";
import { SecretField } from "@/features/secrets/SecretField";
import type { ChannelProfileV2 } from "@/features/channels/domain/profile";
import { parseProfileImport } from "@/features/channels/application/channelService";
import { ChannelModelEditor } from "./ChannelModelEditor";

type Props = {
  draft: ChannelProfileV2;
  onChange: (profile: ChannelProfileV2) => void;
  credential: string;
  onCredential: (key: string) => void;
  busy: boolean;
  onSave: () => void;
  onTest: () => void;
  onError: (error: string) => void;
  /** Result of save/test, rendered right under the actions that produced it. */
  feedback?: ReactNode;
  focusedModelId?: string;
  discoveredModels?: readonly string[];
};
export function ChannelProfileForm({
  draft,
  onChange,
  credential,
  onCredential,
  busy,
  onSave,
  onTest,
  onError,
  feedback,
  focusedModelId,
  discoveredModels = [],
}: Props) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const [source, setSource] = useState("");
  return (
    <div className="min-w-0 space-y-4">
      <label className="block text-xs text-text-muted">
        {t("rework.name")}
        <UiInput
          aria-label={t("rework.name")}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="mt-1.5"
        />
      </label>
      <label className="block text-xs text-text-muted">
        {t("rework.channels.baseUrl")}
        <UiInput
          aria-label={t("rework.channels.baseUrl")}
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
      {draft.auth.type === "none" ? (
        <p className="text-xs text-text-muted">
          {t("ui.channels.status.keyNotRequired")}
        </p>
      ) : (
        <div className="block text-xs text-text-muted">
          {t("rework.channels.key")}
          <SecretField
            label={t("rework.channels.key")}
            value={credential}
            onChange={onCredential}
            className="mt-1.5"
          />
          <span className="mt-1 block text-[11px] leading-5">
            {t("rework.channels.keyHint")}
          </span>
        </div>
      )}
      <ChannelModelEditor
        profile={draft}
        onChange={onChange}
        focusedModelId={focusedModelId}
        discoveredModels={discoveredModels}
      />
      <UiButton
        variant="ghost"
        size="sm"
        aria-expanded={advanced}
        onClick={() => {
          setAdvanced(!advanced);
          setSource(JSON.stringify(draft, null, 2));
        }}
      >
        {t("rework.channels.advanced")}
      </UiButton>
      {advanced && (
        <>
          <UiTextArea
            aria-label={t("rework.channels.advanced")}
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
        <UiButton
          variant="primary"
          icon={<Save />}
          disabled={busy}
          onClick={onSave}
        >
          {t("rework.channels.save")}
        </UiButton>
        <UiButton
          loading={busy}
          icon={<Check />}
          disabled={!draft.operations["models.list"]}
          onClick={onTest}
        >
          {t("rework.channels.test")}
        </UiButton>
      </div>
      <p className="text-[11px] text-text-muted">
        {t("rework.channels.testHint")}
      </p>
      {feedback}
    </div>
  );
}
