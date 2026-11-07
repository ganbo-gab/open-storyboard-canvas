import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUp,
  AudioLines,
  Bot,
  BookOpen,
  Clapperboard,
  Film,
  ImagePlus,
  Images,
  LayoutGrid,
  Music2,
  Play,
  Plus,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { ProjectCard, projectCoverMap } from "@/features/project/ProjectCard";
import { useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import type { WorkbenchKind, WorkbenchReference } from "@/features/workbench/domain/types";
import { isReferenceFile, readReferenceFile } from "@/features/workbench/application/readReferenceFile";
import { listAssets, type AssetRecord } from "@/features/assets/application/assetCatalog";
import { AssetMedia } from "@/features/assets/ui/AssetMedia";
import type { PromptLibraryEntry } from "@/features/promptLibrary/promptLibraryData";
import { queueHomeAgentMessage } from "@/features/agents/ui/homeAgentHandoff";

type Props = {
  onWorkbench: () => void;
  onAgent: () => void;
  onProjects: () => void;
  onAssets: () => void;
  onPrompts: () => void;
};

type Mode = "agent" | "generate" | "canvas";
type MediaKind = Exclude<WorkbenchKind, "chat">;

const KINDS: { id: MediaKind; icon: typeof Images }[] = [
  { id: "image", icon: Images },
  { id: "video", icon: Film },
  { id: "audio", icon: Music2 },
];
const RECENT_PROJECTS = 7;
const RECENT_MEDIA = 10;
const INSPIRATION_COUNT = 10;
/** Categories closest to storyboard work lead the inspiration strip. */
const INSPIRATION_CATEGORIES = ["漫画 / 故事板", "视频模板 - 电影叙事", "海报设计", "3D/手办/潮玩", "产品展示图"];

function greetingKey(hour: number) {
  if (hour < 5 || hour >= 18) return "rework.greetingEvening";
  if (hour < 12) return "rework.greetingMorning";
  return "rework.greetingAfternoon";
}

/** Bundled titles often repeat the category ("漫画 / 故事板 - 火星…"); the badge already shows it. */
function inspirationTitle(entry: PromptLibraryEntry) {
  const prefix = `${entry.category} - `;
  const title = entry.title.startsWith(prefix) ? entry.title.slice(prefix.length) : entry.title;
  return title.trim() || entry.title;
}

function pickInspiration(entries: PromptLibraryEntry[]): PromptLibraryEntry[] {
  const withCover = entries.filter((entry) => entry.coverUrl && /^https?:/.test(entry.coverUrl));
  const picked: PromptLibraryEntry[] = [];
  for (const category of INSPIRATION_CATEGORIES) {
    picked.push(...withCover.filter((entry) => entry.category === category).slice(0, 2));
  }
  for (const entry of withCover) {
    if (picked.length >= INSPIRATION_COUNT) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked.slice(0, INSPIRATION_COUNT);
}

export function StudioHome({ onWorkbench, onAgent, onProjects, onAssets, onPrompts }: Props) {
  const { t } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const openProject = useProjectStore((state) => state.openProject);
  const createProject = useProjectStore((state) => state.createProject);
  const applyPromptToCanvas = useProjectStore((state) => state.applyPromptToCanvas);
  const [mode, setMode] = useState<Mode>("agent");
  const [kind, setKind] = useState<MediaKind>("image");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<WorkbenchReference[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [assets, setAssets] = useState<AssetRecord[] | null>(null);
  const [inspiration, setInspiration] = useState<PromptLibraryEntry[] | null>(null);
  const [brokenCovers, setBrokenCovers] = useState<Set<string>>(() => new Set());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void listAssets()
      .then((value) => active && setAssets(value))
      .catch(() => active && setAssets([]));
    // The bundled library is 1.4MB of JSON; keep it out of the startup chunk.
    void import("@/features/promptLibrary/promptLibraryData")
      .then((module) => active && setInspiration(pickInspiration(module.BUNDLED_COMMUNITY_PROMPTS)))
      .catch(() => active && setInspiration([]));
    return () => {
      active = false;
    };
  }, []);

  const recent = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_PROJECTS),
    [projects],
  );
  const covers = useMemo(() => projectCoverMap(assets), [assets]);
  const media = useMemo(
    () =>
      (assets ?? [])
        .filter((asset) => (asset.kind === "image" || asset.kind === "video") && asset.origin !== "canvas")
        .slice(0, RECENT_MEDIA),
    [assets],
  );

  const addFiles = async (files: FileList | File[]) => {
    const accepted = [...files].filter(isReferenceFile);
    if (!accepted.length) return;
    try {
      const read = await Promise.all(accepted.map(readReferenceFile));
      setReferences((current) => [...current, ...read].slice(0, 6));
    } catch (cause) {
      setError(String(cause));
    }
  };

  const openWorkbenchWith = (nextKind: MediaKind, text: string, refs: WorkbenchReference[]) => {
    const store = useWorkbenchStore.getState();
    if (text) store.createConversation(text.slice(0, 24));
    store.setDraft({ prompt: text, kind: nextKind, references: refs });
    onWorkbench();
  };

  const send = async () => {
    const text = prompt.trim();
    setError("");
    if (mode === "agent") {
      if (!text) {
        textarea.current?.focus();
        return;
      }
      queueHomeAgentMessage(text);
      setPrompt("");
      onAgent();
      return;
    }
    if (mode === "generate") {
      openWorkbenchWith(kind, text, references);
      return;
    }
    if (!text) {
      createProject(t("rework.untitled"));
      return;
    }
    setSending(true);
    try {
      await applyPromptToCanvas({ kind: "new", name: text.slice(0, 24) }, { title: t("rework.prompt"), prompt: text });
    } catch (cause) {
      setError(String(cause));
      setSending(false);
    }
  };

  const useInspiration = (entry: PromptLibraryEntry) => {
    setMode("generate");
    setKind(/视频/.test(entry.category) ? "video" : "image");
    setPrompt(entry.prompt);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
  };

  const hour = new Date().getHours();
  const placeholder = mode === "canvas" ? t("rework.canvasPromptHint") : mode === "agent" ? t("rework.agent.placeholder") : t("rework.promptHint");

  return (
    <div className="studio-page ui-scrollbar h-full overflow-y-auto">
      <div ref={top} className="mx-auto flex min-h-full max-w-[1180px] flex-col px-6 pb-20 pt-[clamp(32px,8vh,88px)] sm:px-10">
        <section className="studio-rise mx-auto flex w-full max-w-[820px] flex-col items-center">
          <h1 className="text-center text-[clamp(26px,3.2vw,34px)] font-semibold tracking-tight text-text-dark">
            {t(greetingKey(hour))}
          </h1>
          <div role="radiogroup" aria-label={t("rework.mode")} className="studio-mode-switch mt-6">
            <button type="button" role="radio" aria-checked={mode === "agent"} onClick={() => setMode("agent")}>
              <Bot />
              {t("rework.modeAgent")}
            </button>
            <button type="button" role="radio" aria-checked={mode === "generate"} onClick={() => setMode("generate")}>
              <Sparkles />
              {t("rework.modeGenerate")}
            </button>
            <button type="button" role="radio" aria-checked={mode === "canvas"} onClick={() => setMode("canvas")}>
              <Workflow />
              {t("rework.modeCanvas")}
            </button>
          </div>

          <div
            className="studio-composer mt-5 w-full p-3.5"
            data-dragging={dragging || undefined}
            onDragOver={(event) => {
              if (mode !== "generate" || !event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              if (mode !== "generate") return;
              event.preventDefault();
              setDragging(false);
              void addFiles(event.dataTransfer.files);
            }}
          >
            <div className="flex gap-3">
              {mode === "generate" && (
                <div className="flex shrink-0 items-start gap-1.5 pl-1 pt-1">
                  {references.map((reference) => (
                    <span key={reference.id} className="studio-ref-tile" title={reference.name}>
                      {reference.kind === "image" ? (
                        <AssetMedia source={reference.source} kind="image" alt={reference.name ?? ""} className="h-full w-full object-cover" />
                      ) : reference.kind === "video" ? (
                        <Film className="h-4 w-4" />
                      ) : (
                        <AudioLines className="h-4 w-4" />
                      )}
                      <button
                        type="button"
                        className="studio-ref-tile__remove"
                        aria-label={t("rework.removeReference")}
                        onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                  {references.length < 6 && (
                    <button
                      type="button"
                      className="studio-ref-tile"
                      title={t("rework.addReference")}
                      aria-label={t("rework.addReference")}
                      onClick={() => upload.current?.click()}
                    >
                      <ImagePlus className="h-[18px] w-[18px]" />
                    </button>
                  )}
                  <input
                    ref={upload}
                    hidden
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/*"
                    onChange={(event) => {
                      if (event.target.files) void addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </div>
              )}
              <textarea
                ref={textarea}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={(event) => {
                  if (mode !== "generate") return;
                  const files = [...event.clipboardData.files];
                  if (files.length) {
                    event.preventDefault();
                    void addFiles(files);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                aria-label={t("rework.prompt")}
                placeholder={placeholder}
                rows={3}
                className="ui-scrollbar block max-h-56 min-h-[76px] w-full flex-1 resize-none bg-transparent px-1 pt-1.5 text-[14.5px] leading-6 text-text-dark outline-none [field-sizing:content]"
              />
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {mode === "generate" ? (
                KINDS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={kind === item.id}
                    onClick={() => setKind(item.id)}
                    className="ui-chip"
                    data-active={kind === item.id || undefined}
                  >
                    <item.icon />
                    {t(`rework.${item.id}`)}
                  </button>
                ))
              ) : mode === "agent" ? (
                <span className="px-2 text-xs text-text-muted">{t("rework.agentModeHint")}</span>
              ) : (
                <span className="px-2 text-xs text-text-muted">{t("rework.canvasModeHint")}</span>
              )}
              <span className="ml-auto hidden pr-1 text-[11.5px] text-text-subtle sm:inline">{t("rework.sendHint")}</span>
              <button
                type="button"
                aria-label={mode === "canvas" ? t("rework.newCanvas") : mode === "agent" ? t("rework.agent.send") : t("rework.openWorkbench")}
                onClick={() => void send()}
                disabled={sending || (mode === "agent" && !prompt.trim())}
                className="studio-send h-9 w-9"
              >
                <ArrowUp className="h-[18px] w-[18px]" />
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </section>

        <section aria-label={t("rework.quickStart")} className="studio-rise mx-auto mt-10 grid w-full max-w-[820px] grid-cols-4 gap-1 sm:grid-cols-7">
          <button type="button" className="studio-tool" data-primary="" onClick={() => createProject(t("rework.untitled"))}>
            <span className="studio-tool__icon"><Plus /></span>
            {t("rework.newCanvas")}
          </button>
          {KINDS.map((item) => (
            <button key={item.id} type="button" className="studio-tool" onClick={() => openWorkbenchWith(item.id, "", [])}>
              <span className="studio-tool__icon"><item.icon /></span>
              {t(`rework.tool.${item.id}`)}
            </button>
          ))}
          <button type="button" className="studio-tool" onClick={onAgent}>
            <span className="studio-tool__icon"><Sparkles /></span>
            {t("rework.agent.home")}
          </button>
          <button type="button" className="studio-tool" onClick={onAssets}>
            <span className="studio-tool__icon"><LayoutGrid /></span>
            {t("rework.assets")}
          </button>
          <button type="button" className="studio-tool" onClick={onPrompts}>
            <span className="studio-tool__icon"><BookOpen /></span>
            {t("rework.prompts")}
          </button>
        </section>

        <section className="mt-14">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="studio-section-title">{t("rework.recentCanvases")}</h2>
            {projects.length > 0 && (
              <button type="button" onClick={onProjects} className="studio-link">
                {t("rework.all")}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-4">
            <button type="button" className="studio-card" onClick={() => createProject(t("rework.untitled"))}>
              <span className="studio-card__media aspect-[16/10]" data-new="">
                <span className="studio-card__plus"><Plus className="h-5 w-5" /></span>
                <span className="relative text-[13px]">{t("rework.newCanvas")}</span>
              </span>
              <span className="px-0.5 text-xs text-text-subtle">
                {projects.length ? t("rework.canvasHint") : t("rework.emptyProjects")}
              </span>
            </button>
            {recent.map((project) => (
              <ProjectCard key={project.id} project={project} cover={covers.get(project.id)} onOpen={() => openProject(project.id)} />
            ))}
          </div>
        </section>

        {(assets === null || media.length > 0) && (
          <section className="mt-14">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="studio-section-title">{t("rework.recentMedia")}</h2>
              <button type="button" onClick={onAssets} className="studio-link">
                {t("rework.assets")}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 md:grid-cols-4 xl:grid-cols-5">
              {assets === null
                ? Array.from({ length: 5 }, (_, index) => <span key={index} className="studio-skeleton aspect-square" />)
                : media.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      className="studio-card"
                      title={asset.name}
                      onClick={() => (asset.projectId ? openProject(asset.projectId) : onAssets())}
                    >
                      <span className="studio-card__media block aspect-square">
                        <AssetMedia
                          source={asset.kind === "image" ? asset.previewUrl || asset.source : asset.source}
                          kind={asset.kind === "video" ? "video" : "image"}
                          alt={asset.name}
                          className="h-full w-full object-cover"
                        />
                        {asset.kind === "video" && (
                          <span className="studio-card__badge"><Play />{t("rework.video")}</span>
                        )}
                        <span className="studio-card__overlay">
                          <span className="truncate text-xs font-medium">{asset.name}</span>
                          {typeof asset.metadata.projectName === "string" && (
                            <span className="truncate text-[11px] opacity-75">{asset.metadata.projectName}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
            </div>
          </section>
        )}

        {(inspiration === null || inspiration.length > 0) && (
          <section className="mt-14">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-baseline gap-3">
                <h2 className="studio-section-title">{t("rework.inspiration")}</h2>
                <span className="text-xs text-text-subtle">{t("rework.inspirationHint")}</span>
              </div>
              <button type="button" onClick={onPrompts} className="studio-link">
                {t("rework.prompts")}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {inspiration === null
                ? Array.from({ length: 5 }, (_, index) => <span key={index} className="studio-skeleton aspect-[3/4]" />)
                : inspiration
                    .filter((entry) => !brokenCovers.has(entry.id))
                    .map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="studio-card"
                        title={entry.title}
                        onClick={() => useInspiration(entry)}
                      >
                        <span className="studio-card__media block aspect-[3/4]">
                          <img
                            src={entry.coverUrl}
                            alt={entry.title}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={() => setBrokenCovers((current) => new Set(current).add(entry.id))}
                          />
                          <span className="studio-card__badge">
                            {/视频/.test(entry.category) ? <Clapperboard /> : <Images />}
                            {entry.category.replace(/^(图像|视频)模板 - /, "")}
                          </span>
                          <span className="studio-card__overlay" data-persistent="">
                            <span className="line-clamp-2 text-[12.5px] font-medium leading-snug">{inspirationTitle(entry)}</span>
                            <span className="mt-1 text-[11px] opacity-80">{t("rework.useInspiration")}</span>
                          </span>
                        </span>
                      </button>
                    ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
