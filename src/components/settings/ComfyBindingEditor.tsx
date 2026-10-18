import { useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { CheckCircle2, Loader2, SearchCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { detectComfyUIBindings } from "@/features/channels/adapters/comfyui/bindings";
import type { ComfyUIParameter } from "@/features/channels/adapters/comfyui/bindings";
import type { ComfyUIInputBinding } from "@/features/channels/adapters/comfyui/workflow";
import { preflightComfyUIWorkflow } from "@/features/channels/adapters/comfyui/preflight";
import {
  resolveComfyUIUrls,
  applyComfyUIAuth,
} from "@/features/channels/adapters/comfyui/url";
import { customHttpRequest } from "@/commands/ai";

type Props = {
  workflowText: string;
  bindingsText: string;
  outputsText: string;
  baseUrl: string;
  apiKey: string;
  auth: { mode: string; name: string; prefix: string };
  onBindings: (text: string) => void;
  onOutputs: (text: string) => void;
};
export function ComfyBindingEditor({
  workflowText,
  bindingsText,
  outputsText,
  baseUrl,
  apiKey,
  auth,
  onBindings,
  onOutputs,
}: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState("");
  const [passed, setPassed] = useState(false);
  const parsed = useMemo(() => {
    try {
      const workflow: unknown = JSON.parse(workflowText);
      return {
        workflow,
        detections: detectComfyUIBindings(workflow),
        bindings: JSON.parse(bindingsText || "{}") as Record<
          string,
          ComfyUIInputBinding | ComfyUIInputBinding[]
        >,
        outputs: JSON.parse(outputsText || "[]") as string[],
      };
    } catch {
      return null;
    }
  }, [workflowText, bindingsText, outputsText]);
  const urls = useMemo(() => {
    try {
      return resolveComfyUIUrls(baseUrl);
    } catch {
      return null;
    }
  }, [baseUrl]);
  const preflight = async () => {
    if (!parsed || !urls) return;
    setBusy(true);
    setReport("");
    setPassed(false);
    try {
      const value = `${auth.prefix || ""}${apiKey}`;
      const mode =
        auth.mode === "bearer"
          ? { mode: "bearer" as const, value: apiKey }
          : auth.mode === "header"
            ? { mode: "header" as const, name: auth.name, value }
            : auth.mode === "query"
              ? { mode: "query" as const, name: auth.name, value }
              : { mode: "none" as const };
      const request = applyComfyUIAuth(urls.objectInfo, mode);
      let text: string;
      if (isTauri()) {
        const response = await customHttpRequest({
          ...request,
          method: "GET",
          timeoutMs: 15000,
          maxResponseBytes: 8 * 1024 * 1024,
        });
        if (response.status < 200 || response.status >= 300)
          throw new Error(`HTTP ${response.status}`);
        text = response.text;
      } else {
        const response = await fetch(request.url, {
          headers: request.headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        text = await response.text();
      }
      const result = preflightComfyUIWorkflow(
        JSON.parse(text),
        parsed.workflow,
      );
      setPassed(result.ok);
      setReport(
        result.ok
          ? t("rework.comfy.ready")
          : [
              ...result.missingNodeClasses.map(
                (item) => `${item.nodeId}: ${item.classType}`,
              ),
              ...result.missingModelFiles.map(
                (item) => `${item.nodeId}.${item.input}: ${item.filename}`,
              ),
            ].join("\n"),
      );
    } catch (cause) {
      setReport(String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!parsed)
    return (
      <p className="text-xs text-text-muted">{t("rework.comfy.importHint")}</p>
    );
  const parameters = Object.keys(parsed.detections).filter(
    (parameter) => parameter !== "negativePrompt",
  ) as ComfyUIParameter[];
  return (
    <section className="space-y-3 rounded-xl border border-border-dark bg-bg-dark/40 p-4">
      <div>
        <h3 className="text-xs font-semibold text-text-dark">
          {t("rework.comfy.title")}
        </h3>
        <p className="mt-1 text-[11px] leading-5 text-text-muted">
          {t("rework.comfy.hint")}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {parameters.map((parameter) => {
          const detection = parsed.detections[parameter];
          const imageIndex = parameter.startsWith("image")
            ? Number(parameter.slice(5)) - 1
            : -1;
          const imageBindings = Array.isArray(parsed.bindings.images)
            ? parsed.bindings.images
            : [];
          const current =
            parameter === "output"
              ? parsed.outputs[0]
                ? { nodeId: parsed.outputs[0], input: "$output" }
                : undefined
              : imageIndex >= 0
                ? imageBindings[imageIndex]
                : (parsed.bindings[parameter] as
                    | ComfyUIInputBinding
                    | undefined);
          const selected = current
            ? `${current.nodeId}.${current.input}`
            : detection.binding
              ? `${detection.binding.nodeId}.${detection.binding.input}`
              : "";
          return (
            <label key={parameter} className="block text-xs text-text-muted">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span>
                  {imageIndex >= 0
                    ? t("rework.comfy.image", { index: imageIndex + 1 })
                    : t(`rework.comfy.${parameter}`)}
                </span>
                <span
                  className={`text-[10px] ${!selected ? "text-amber-500" : "text-emerald-500"}`}
                >
                  {current
                    ? t("rework.configured")
                    : t(
                        `rework.comfy.${detection.status === "auto" ? "auto" : detection.status === "ambiguous" ? "ambiguous" : "missing"}`,
                      )}
                </span>
              </div>
              <select
                value={selected}
                aria-label={parameter}
                onChange={(event) => {
                  const candidate = detection.candidates.find(
                    (item) =>
                      `${item.nodeId}.${item.input}` === event.target.value,
                  );
                  if (!candidate) return;
                  if (parameter === "output") {
                    onOutputs(JSON.stringify([candidate.nodeId], null, 2));
                    return;
                  }
                  const bindings = { ...parsed.bindings };
                  const binding = {
                    nodeId: candidate.nodeId,
                    input: candidate.input,
                  };
                  if (imageIndex >= 0) {
                    const images = [...imageBindings];
                    images[imageIndex] = binding;
                    bindings.images = images;
                  } else bindings[parameter] = binding;
                  onBindings(JSON.stringify(bindings, null, 2));
                }}
                className="h-9 w-full rounded-lg border border-border-dark bg-surface-dark px-2 text-xs text-text-dark"
              >
                <option value="">{t("rework.comfy.ambiguous")}</option>
                {detection.candidates.map((candidate) => (
                  <option
                    key={`${candidate.nodeId}.${candidate.input}`}
                    value={`${candidate.nodeId}.${candidate.input}`}
                  >
                    {candidate.nodeId} · {candidate.title} · {candidate.input}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      {urls && (
        <div className="overflow-x-auto rounded-lg bg-surface-dark/60 p-3 font-mono text-[10px] leading-6 text-text-muted">
          <div>{urls.prompt}</div>
          <div>
            {urls.history}/{"{promptId}"}
          </div>
          <div>{urls.view}</div>
        </div>
      )}
      <button
        type="button"
        disabled={busy || !urls}
        onClick={() => void preflight()}
        className="flex h-9 items-center gap-2 rounded-lg border border-border-dark px-3 text-xs text-text-dark hover:bg-surface-dark disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <SearchCheck className="h-3.5 w-3.5" />
        )}
        {t(busy ? "rework.comfy.checking" : "rework.comfy.preflight")}
      </button>
      {report && (
        <div
          role="status"
          className={`flex items-start gap-2 whitespace-pre-wrap break-words text-xs leading-6 ${passed ? "text-emerald-500" : "text-amber-500"}`}
        >
          {passed && <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />}
          {report}
        </div>
      )}
    </section>
  );
}
