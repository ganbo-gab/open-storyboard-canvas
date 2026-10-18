import { useEffect, useRef, useState } from "react";
import { Clapperboard, MessageSquarePlus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "../store/workbenchStore";
import { WorkbenchComposer } from "./WorkbenchComposer";
import { GenerationCard } from "./GenerationCard";

type Props = { onSettings: () => void };
export function WorkbenchPage({ onSettings }: Props) {
  const { t } = useTranslation();
  const conversations = useWorkbenchStore((state) => state.conversations);
  const selected = useWorkbenchStore((state) => state.selectedConversationId);
  const tasks = useWorkbenchStore((state) => state.tasks);
  const initialize = useWorkbenchStore((state) => state.initialize);
  const [search, setSearch] = useState("");
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  const visible = Object.values(tasks)
    .filter((task) => task.conversationId === selected)
    .sort((a, b) => a.createdAt - b.createdAt);
  const latestId = visible[visible.length - 1]?.id;
  useEffect(() => {
    if (feed.current)
      feed.current.scrollTo({
        top: feed.current.scrollHeight,
        behavior: "smooth",
      });
  }, [selected, latestId]);
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border-dark bg-surface-dark/20 p-3 lg:flex">
        <button
          type="button"
          onClick={() =>
            useWorkbenchStore
              .getState()
              .createConversation(t("rework.conversation"))
          }
          className="flex h-10 items-center gap-2 rounded-lg border border-border-dark px-3 text-xs text-text-dark hover:bg-surface-dark"
        >
          <MessageSquarePlus className="h-4 w-4" />
          {t("rework.conversation")}
        </button>
        <label className="mt-3 flex items-center gap-2 rounded-lg border border-border-dark px-2">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t("rework.search")}
            placeholder={t("rework.search")}
            className="h-9 min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none"
          />
        </label>
        <div className="ui-scrollbar mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
          {Object.values(conversations)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .filter((item) =>
              item.title.toLowerCase().includes(search.toLowerCase()),
            )
            .map((item) => (
              <div
                key={item.id}
                className={`group flex items-center rounded-lg ${item.id === selected ? "bg-text-dark/6" : "hover:bg-text-dark/3"}`}
              >
                <button
                  type="button"
                  onClick={() =>
                    useWorkbenchStore.getState().selectConversation(item.id)
                  }
                  className="min-w-0 flex-1 truncate px-3 py-3 text-left text-xs text-text-dark"
                >
                  {item.title}
                </button>
                <button
                  type="button"
                  title={t("rework.delete")}
                  aria-label={t("rework.delete")}
                  onClick={() => {
                    if (window.confirm(t("rework.confirmDelete")))
                      useWorkbenchStore.getState().deleteConversation(item.id);
                  }}
                  className="mr-1 rounded-md p-2 text-text-muted hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
        </div>
      </aside>
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-dark px-5">
          <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
            <Clapperboard className="h-4 w-4 text-text-muted" />
            {selected ? conversations[selected]?.title : t("rework.workbench")}
          </div>
          <button
            type="button"
            onClick={() =>
              useWorkbenchStore
                .getState()
                .createConversation(t("rework.conversation"))
            }
            title={t("rework.conversation")}
            aria-label={t("rework.conversation")}
            className="rounded-lg p-2 text-text-muted hover:bg-surface-dark"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </header>
        <div
          ref={feed}
          className="ui-scrollbar min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 pb-4 sm:px-8"
        >
          <div className="mx-auto max-w-3xl space-y-5 pt-7">
            {!visible.length && (
              <div className="flex min-h-48 flex-col items-center justify-center py-14 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-dark bg-surface-dark">
                  <Clapperboard className="h-5 w-5 text-accent" />
                </div>
                <h1 className="text-xl font-semibold text-text-dark">
                  {t("rework.noHistory")}
                </h1>
                <p className="mt-3 max-w-md text-sm leading-7 text-text-muted">
                  {t("rework.historyHint")}
                </p>
              </div>
            )}
            {visible.map((task) => (
              <GenerationCard key={task.id} task={task} />
            ))}
          </div>
        </div>
        {visible.length > 2 && (
          <nav
            aria-label={t("rework.history")}
            className="absolute right-2 top-20 hidden max-h-[40%] flex-col gap-1 overflow-y-auto xl:flex"
          >
            {visible.map((task, index) => (
              <button
                key={task.id}
                type="button"
                title={task.input.prompt}
                onClick={() =>
                  document
                    .getElementById(`generation-${task.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border-dark bg-surface-dark text-[10px] text-text-muted hover:border-accent hover:text-accent"
              >
                {index + 1}
              </button>
            ))}
          </nav>
        )}
        <div className="shrink-0 px-4 pb-4 pt-2 sm:px-8">
          <div className="mx-auto max-w-3xl">
            <WorkbenchComposer onSettings={onSettings} />
          </div>
        </div>
      </section>
    </div>
  );
}
