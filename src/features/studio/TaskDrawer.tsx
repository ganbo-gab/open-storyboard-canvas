import { useEffect, useState } from "react";
import { ArrowUpRight, CircleAlert, Loader2, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { UiIconButton } from "@/components/ui";
import { selectRunningTasks, selectAttentionTasks, useWorkbenchStore } from "@/features/workbench/store/workbenchStore";
import { workbenchTaskStatusLabel } from "@/features/workbench/application/taskHealth";
import type { WorkbenchTask } from "@/features/workbench/domain/types";

/** Cross-conversation drawer of unresolved workbench tasks; opening one jumps to its card. */
export function TaskDrawer({ onClose, onOpenTask }: { onClose(): void; onOpenTask(task: WorkbenchTask): void }) {
  const { t, i18n } = useTranslation();
  const running = useWorkbenchStore(useShallow(selectRunningTasks));
  const attention = useWorkbenchStore(useShallow(selectAttentionTasks));
  const taskCount = running.length + attention.length;
  const conversations = useWorkbenchStore((state) => state.conversations);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside role="dialog" aria-label={t("rework.taskDrawer.title")} className="studio-task-drawer">
      <header className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
        <h2 className="flex-1 text-sm font-medium text-text-dark">{t("rework.taskDrawer.title")} · {taskCount}</h2>
        <UiIconButton aria-label={t("rework.close")} onClick={onClose}><X /></UiIconButton>
      </header>
      <div className="ui-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!taskCount && <p className="py-10 text-center text-xs text-text-muted">{t("rework.taskDrawer.empty")}</p>}
        {[{ key: 'running', tasks: running, live: true }, { key: 'attention', tasks: attention, live: false }].map(({ key, tasks, live }) => tasks.length > 0 && (
          <section key={key} className="space-y-2" aria-label={t(`rework.taskDrawer.${key}`)}>
            <h3 className="pt-2 text-xs font-medium text-text-dark">{t(`rework.taskDrawer.${key}`)} · {tasks.length}</h3>
            {!live && <p className="pb-1 text-[11px] leading-5 text-text-muted">{t("rework.taskDrawer.attentionHint")}</p>}
            {tasks.map((task) => (
            <article key={task.id} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)] p-3">
              <p className="line-clamp-2 text-[12.5px] leading-5 text-text-dark">{task.input.prompt}</p>
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-muted">
                {live ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" /> : <CircleAlert className="h-3 w-3 shrink-0 text-warning" />}
                <span>{t(`rework.taskDrawer.status.${workbenchTaskStatusLabel(task)}`)}</span>
                {live && <span className="ml-auto font-mono tabular-nums">{Math.max(0, Math.round((now - (task.tracking?.startedAt ?? task.createdAt)) / 1000))}s</span>}
              </div>
              <p className="mt-1 truncate text-[11px] text-text-muted">{conversations[task.conversationId]?.title}</p>
              {!live && <p className="mt-1 text-[11px] text-text-muted">{t("rework.taskDrawer.lastUpdated", { time: new Date(task.updatedAt).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>}
              <div className="mt-2 flex justify-end gap-1">
                {live && (
                  <UiIconButton aria-label={t("rework.stop")} title={t("rework.stop")} onClick={() => useWorkbenchStore.getState().cancelWaiting(task.id)}>
                    <Square className="h-3.5 w-3.5" />
                  </UiIconButton>
                )}
                <UiIconButton aria-label={t("rework.taskDrawer.open")} title={t("rework.taskDrawer.open")} onClick={() => onOpenTask(task)}>
                  <ArrowUpRight className="h-4 w-4" />
                </UiIconButton>
              </div>
            </article>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
