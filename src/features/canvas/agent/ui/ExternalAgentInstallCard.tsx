import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Check, FileCode2, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const apply = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      const result = remove
        ? await uninstallExternalAgent(cli)
        : await installExternalAgent(cli);
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
    <section className="rounded-xl border border-border-dark bg-bg-dark/50 p-4">
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
        {installed && <Check className="h-4 w-4 text-emerald-500" />}
      </div>
      {!isTauri() ? (
        <p className="mt-3 text-xs text-text-muted">
          {t("rework.external.desktopOnly")}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !connected}
            onClick={() => void preview()}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-dark px-3 text-xs text-text-dark transition-colors hover:bg-surface-dark disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileCode2 className="h-4 w-4" />
            )}
            {t("rework.external.preview")}
          </button>
          {installed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("rework.external.confirmRemove")))
                  void apply(true);
              }}
              className="h-9 rounded-lg px-3 text-xs text-text-muted hover:text-red-400"
            >
              {t("rework.external.remove")}
            </button>
          )}
        </div>
      )}
      {diff !== null && (
        <div className="mt-3 space-y-3">
          <pre className="max-h-64 overflow-auto rounded-lg bg-surface-dark p-3 text-[11px] leading-relaxed text-text-dark">
            {diff || t("rework.external.noChanges")}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply(false)}
              className="h-9 rounded-lg bg-accent px-4 text-xs font-medium text-white disabled:opacity-40"
            >
              {t("rework.external.apply")}
            </button>
            <button
              type="button"
              onClick={() => setDiff(null)}
              className="px-3 text-xs text-text-muted"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-emerald-500">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
