import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Check, FileCode2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UiButton, UiConfirm } from "@/components/ui";
import {
  installExternalAgent,
  uninstallExternalAgent,
  inspectExternalAgentInstallStatus,
  previewExternalAgentInstall,
  type ExternalAgentRuntime,
} from "@/commands/externalAgent";

type Props = { cli: ExternalAgentRuntime; connected: boolean };

/** Native config writes happen only after the user has reviewed the exact diff. */
export function ExternalAgentInstallCard({ cli, connected }: Props) {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<ExternalAgentRuntime | null>(null);
  useEffect(() => {
    let active = true;
    setDiff(null);
    setError("");
    setNotice("");
    setInstalled(false);
    if (isTauri())
      void inspectExternalAgentInstallStatus(cli)
        .then((status) => {
          if (active) {
            setInstalled(status.installed);
            setPath(status.path);
          }
        })
        .catch((cause: unknown) => {
          if (active) setError(String(cause));
        });
    return () => {
      active = false;
    };
  }, [cli, connected]);
  const preview = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await previewExternalAgentInstall(cli);
      setPath(result.status.path);
      setDiff(result.diff);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (remove: boolean, target: ExternalAgentRuntime = cli) => {
    setBusy(true);
    setError("");
    try {
      const result = remove
        ? await uninstallExternalAgent(target)
        : await installExternalAgent(target);
      setInstalled(result.status.installed);
      setDiff(null);
      setNotice(
        remove ? t("rework.external.removed") : t("rework.external.installed"),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--field-bg)] p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-text-dark">
            {t("rework.external.title")}
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            {t("rework.external.description")}
          </p>
          {path && (
            <p className="mt-2 break-all font-mono text-[11px] text-text-muted">
              {path}
            </p>
          )}
        </div>
        {installed && <Check className="h-4 w-4 text-success" />}
      </div>
      {!isTauri() ? (
        <p className="mt-3 text-xs text-text-muted">
          {t("rework.external.desktopOnly")}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <UiButton
            variant="secondary"
            disabled={!connected}
            loading={busy}
            icon={<FileCode2 />}
            onClick={() => void preview()}
          >
            {t("rework.external.preview")}
          </UiButton>
          {installed && (
            <UiButton
              variant="ghost"
              disabled={busy}
              onClick={() => setPendingRemoval(cli)}
            >
              {t("rework.external.remove")}
            </UiButton>
          )}
        </div>
      )}
      {diff !== null && (
        <div className="mt-3 space-y-3">
          <pre className="ui-scrollbar max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3 text-[11px] leading-relaxed text-text-dark">
            {diff || t("rework.external.noChanges")}
          </pre>
          <div className="flex gap-2">
            <UiButton
              variant="primary"
              disabled={busy}
              onClick={() => void apply(false)}
            >
              {t("rework.external.apply")}
            </UiButton>
            <UiButton variant="ghost" onClick={() => setDiff(null)}>
              {t("common.cancel")}
            </UiButton>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words text-xs text-danger">
          {error}
        </p>
      )}
      <UiConfirm
        isOpen={pendingRemoval !== null}
        title={t("rework.external.remove")}
        description={t("rework.external.confirmRemove")}
        confirmLabel={t("rework.external.remove")}
        onConfirm={() => { if (pendingRemoval) void apply(true, pendingRemoval); }}
        onClose={() => setPendingRemoval(null)}
      />
    </section>
  );
}
