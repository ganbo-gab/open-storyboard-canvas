import { create } from 'zustand';
import { saveAsset } from '@/features/assets/application/assetCatalog';
import { classifyWorkbenchFailure, emptyWorkbenchData, type WorkbenchData, type WorkbenchDraft, type WorkbenchResult, type WorkbenchSubmitInput, type WorkbenchTask } from '../domain/types';
import { workbenchDocument, type LocalDocument, type LocalStorageStatus } from '../application/workbenchPersistence';
import { workbenchTransport, type WorkbenchTransport } from '../application/workbenchTransport';
import { importWorkbenchResult } from '../application/importWorkbenchResult';
import { externalizeAssetMedia, persistAssetMedia } from '@/features/assets/application/assetMediaStorage';

export interface WorkbenchState extends WorkbenchData {
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  initialize(): Promise<void>;
  createConversation(title?: string): string;
  renameConversation(id: string, title: string): void;
  deleteConversation(id: string): void;
  selectConversation(id: string): void;
  setDraft(patch: Partial<WorkbenchDraft>): void;
  submit(input: WorkbenchSubmitInput): Promise<string>;
  poll(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  recoverResult(taskId: string): Promise<void>;
  cancelWaiting(taskId: string): void;
  importResult(taskId: string, projectId: string, resultIndex?: number): Promise<string>;
}
export interface WorkbenchDependencies {
  document: LocalDocument<WorkbenchData>;
  transport: WorkbenchTransport;
  saveResult?: typeof saveAsset;
}
/** Own state/pollers only: generation never touches the active canvas. */
export function createWorkbenchStore(dependencies: WorkbenchDependencies) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const polling = new Map<string, Promise<void>>();
  const storage = dependencies.document;
  let editedBeforeHydration = false;
  let pendingDraft: Partial<WorkbenchDraft> = {};
  return create<WorkbenchState>((set, get) => {
    const persist = () => {
      if (!get().initialized) {
        editedBeforeHydration = true;
        void get().initialize().then(persist);
        return;
      }
      const { conversations, messages, tasks, selectedConversationId, draft } = get();
      storage.save({ conversations, messages, tasks, selectedConversationId, draft });
      set({ storageStatus: storage.status() });
      if (storage.flush) void storage.flush().catch(() => undefined).then(() => set({ storageStatus: storage.status() }));
    };
    const changeTask = (id: string, patch: Partial<WorkbenchTask>) => {
      const task = get().tasks[id];
      if (!task) return;
      set({ tasks: { ...get().tasks, [id]: { ...task, ...patch, updatedAt: Date.now() } } });
      persist();
    };
    const finish = async (id: string, results: WorkbenchResult[]) => {
      const task = get().tasks[id];
      if (!task) return;
      if (!results.length || results.some((item) => !item.source.trim())) throw new Error('结果为空，未报告生成成功');
      try {
        results = await Promise.all(results.map(async (result) => ({ ...result, source: result.kind === 'text' ? result.source : await persistAssetMedia(result.source, true, result.kind) })));
      } catch (error) {
        changeTask(id, { status: 'recoverable_wait', results, failure: { kind: 'network', message: `上游已返回结果，本地保存失败；可仅取回结果，不会重新提交：${classifyWorkbenchFailure(error).message}` } });
        await storage.flush?.();
        return;
      }
      // Publish real results first; a catalogue storage problem cannot turn success into a paid retry.
      changeTask(id, { status: 'succeeded', results, failure: undefined });
      const messageId = `${id}:assistant`;
      set({ messages: { ...get().messages, [messageId]: { id: messageId, conversationId: task.conversationId,
        role: 'assistant', text: results.filter((result) => result.kind === 'text').map((result) => result.source).join('\n'), taskId: id, createdAt: Date.now() } } });
      persist();
      const saved: WorkbenchResult[] = [];
      try {
        for (const [index, result] of results.entries()) {
          const asset = await (dependencies.saveResult ?? saveAsset)({ id: `workbench:${id}:${index}`, name: task.input.prompt.slice(0, 80),
            kind: result.kind, source: result.source, origin: 'generated', taskId: id,
            metadata: { prompt: task.input.prompt, model: task.input.model, config: task.input.config ?? {}, references: task.input.references ?? [], jobId: task.jobId, durationMs: Date.now() - task.createdAt } });
          saved.push({ ...result, source: asset.source, assetId: asset.id });
        }
        changeTask(id, { results: saved });
        await storage.flush?.();
      } catch (error) {
        changeTask(id, { failure: { kind: 'storage', message: `生成已成功；资产登记失败：${classifyWorkbenchFailure(error).message}` } });
      }
    };
    const schedule = (id: string) => {
      if (timers.has(id)) clearTimeout(timers.get(id));
      const task = get().tasks[id];
      if (!task || task.waitingCanceled || !['queued', 'submitting', 'running', 'materializing'].includes(task.status)) return;
      timers.set(id, setTimeout(() => { timers.delete(id); void get().poll(id); }, 2000));
    };
    return {
      ...emptyWorkbenchData(), initialized: false, storageStatus: { mode: 'persistent' },
      async initialize() {
        if (get().initialized) return;
        await storage.initialize?.();
        if (get().initialized) return;
        const loaded = storage.load();
        const current = get();
        const data = editedBeforeHydration ? { ...loaded, conversations: { ...loaded.conversations, ...current.conversations },
          messages: { ...loaded.messages, ...current.messages }, tasks: { ...loaded.tasks, ...current.tasks },
          selectedConversationId: current.selectedConversationId ?? loaded.selectedConversationId, draft: { ...loaded.draft, ...pendingDraft } } : loaded;
        const tasks = { ...data.tasks };
        for (const [id, task] of Object.entries(tasks)) {
          if (['submitting', 'running', 'queued', 'materializing'].includes(task.status) && !task.jobId) {
            tasks[id] = { ...task, status: 'unknown', failure: { kind: 'interrupted', message: '提交过程被中断，无法确认上游结果；不会自动重新提交。' } };
          }
        }
        set({ ...data, tasks, initialized: true, storageStatus: storage.status() });
        for (const task of Object.values(tasks)) if (task.jobId && !task.waitingCanceled) schedule(task.id);
      },
      createConversation(title = '新对话') {
        if (!get().initialized) void get().initialize();
        const id = crypto.randomUUID(); const now = Date.now();
        set({ conversations: { ...get().conversations, [id]: { id, title: title.trim() || '新对话', createdAt: now, updatedAt: now } }, selectedConversationId: id });
        persist(); return id;
      },
      renameConversation(id, title) {
        const current = get().conversations[id];
        if (!current || !title.trim()) throw new Error('Conversation and non-empty title are required');
        set({ conversations: { ...get().conversations, [id]: { ...current, title: title.trim(), updatedAt: Date.now() } } }); persist();
      },
      deleteConversation(id) {
        const conversations = { ...get().conversations }; delete conversations[id];
        for (const task of Object.values(get().tasks)) if (task.conversationId === id) { clearTimeout(timers.get(task.id)); timers.delete(task.id); }
        set({ conversations, messages: Object.fromEntries(Object.entries(get().messages).filter(([, item]) => item.conversationId !== id)),
          tasks: Object.fromEntries(Object.entries(get().tasks).filter(([, item]) => item.conversationId !== id)),
          selectedConversationId: get().selectedConversationId === id ? Object.keys(conversations)[0] ?? null : get().selectedConversationId }); persist();
      },
      selectConversation(id) {
        if (!get().conversations[id]) throw new Error('Conversation not found');
        set({ selectedConversationId: id }); persist();
      },
      setDraft(patch) {
        const allowed: Partial<WorkbenchDraft> = {};
        if (patch.kind !== undefined) allowed.kind = patch.kind;
        if (patch.prompt !== undefined) allowed.prompt = patch.prompt;
        if (patch.model !== undefined) allowed.model = patch.model;
        if ('config' in patch) allowed.config = patch.config;
        if ('references' in patch) allowed.references = patch.references;
        if (!get().initialized) pendingDraft = { ...pendingDraft, ...allowed };
        const draft = get().draft;
        set({ draft: { kind: allowed.kind ?? draft.kind, prompt: allowed.prompt ?? draft.prompt,
          model: allowed.model ?? draft.model, config: 'config' in allowed ? allowed.config : draft.config,
          references: 'references' in allowed ? allowed.references : draft.references } });
        persist();
        if ('references' in allowed && allowed.references?.some((reference) => /^(data:|blob:)/.test(reference.source))) {
          const originalReferences = allowed.references;
          void externalizeAssetMedia(originalReferences).then((references) => {
            if (get().draft.references !== originalReferences) return;
            if (!get().initialized) pendingDraft = { ...pendingDraft, references };
            set({ draft: { ...get().draft, references } });
            persist();
          }).catch((error: unknown) => {
            set({ storageStatus: { mode: 'memory', reason: classifyWorkbenchFailure(error).message } });
          });
        }
      },
      async submit(input) {
        await get().initialize();
        if (!input.prompt.trim() || !input.model.trim()) throw new Error('提示词和模型不能为空');
        if (input.config?.seconds !== undefined && (!Number.isFinite(input.config.seconds) || input.config.seconds <= 0)) throw new Error('视频时长必须大于零');
        const rejectSecrets = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          for (const [key, entry] of Object.entries(value)) {
            if (/api.?key|authorization|cookie|password|secret|access.?token/i.test(key)) throw new Error('请在渠道设置中配置凭据，不要放入生成参数');
            rejectSecrets(entry);
          }
        };
        rejectSecrets(input.config?.extraParams);
        const normalized = await externalizeAssetMedia(structuredClone(input));
        normalized.prompt = input.prompt.trim();
        const conversationId = input.conversationId ?? get().selectedConversationId ?? get().createConversation(input.prompt.slice(0, 32));
        const conversation = get().conversations[conversationId];
        if (!conversation) throw new Error('Conversation not found');
        const history = Object.values(get().messages).filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt);
        const id = crypto.randomUUID(); const now = Date.now();
        const task: WorkbenchTask = { id, conversationId, input: { ...normalized, conversationId }, status: 'submitting', results: [], waitingCanceled: false, createdAt: now, updatedAt: now };
        set({ tasks: { ...get().tasks, [id]: task }, conversations: { ...get().conversations, [conversationId]: { ...conversation, updatedAt: now } },
          messages: { ...get().messages, [id]: { id, conversationId, role: 'user', text: normalized.prompt, taskId: id, createdAt: now } } });
        persist();
        try { await storage.flush?.(); }
        catch { set({ storageStatus: storage.status() }); }
        if (get().storageStatus.mode === 'memory') {
          changeTask(id, { status: 'failed', failure: { kind: 'storage', message: '本地记录无法持久保存；为避免丢失付费任务，本次请求未发送。' } });
          return id;
        }
        try {
          const submitted = await dependencies.transport.submit(normalized, history);
          if (submitted.jobId) {
            changeTask(id, { jobId: submitted.jobId, status: 'running' });
            await get().poll(id);
          } else if (submitted.results) await finish(id, submitted.results);
          else throw new Error('生成服务未返回任务编号或结果');
        } catch (error) {
          const failure = classifyWorkbenchFailure(error, true);
          changeTask(id, { status: failure.kind === 'unknown-submit' ? 'unknown' : 'failed', failure });
        }
        return id;
      },
      async poll(id) {
        if (polling.has(id)) return await polling.get(id);
        const task = get().tasks[id];
        if (!task?.jobId) throw new Error('Task has no recoverable job id');
        const pending = (async () => {
          try {
            const job = await dependencies.transport.poll(task);
            if (!get().tasks[id]) return;
            if (job.status === 'succeeded' && job.result) {
              changeTask(id, { job });
              if (get().tasks[id].status !== 'succeeded') await finish(id, [{ kind: task.input.kind === 'chat' ? 'text' : task.input.kind, source: job.result }]);
            } else if (job.status === 'not_found' || job.status === 'succeeded') {
              changeTask(id, { job, status: 'recoverable_wait', failure: { kind: 'network', message: job.error || '暂未找到任务或结果，保留原任务编号；不会重新提交。' } });
            } else {
              changeTask(id, { job, status: job.status, failure: job.error ? classifyWorkbenchFailure(job.error) : undefined });
            }
          } catch (error) { changeTask(id, { status: 'recoverable_wait', failure: classifyWorkbenchFailure(error) }); }
          finally { polling.delete(id); schedule(id); }
        })();
        polling.set(id, pending); await pending;
      },
      async resume(id) {
        const task = get().tasks[id];
        if (task && !task.jobId && task.results.length) { changeTask(id, { waitingCanceled: false }); await finish(id, task.results); return; }
        if (!task?.jobId) throw new Error('没有安全恢复编号；不会重新提交');
        changeTask(id, { waitingCanceled: false });
        await get().poll(id);
      },
      async recoverResult(id) {
        const task = get().tasks[id];
        if (task && task.results.length && task.status !== 'succeeded' && (!task.jobId || task.failure?.kind !== 'interrupted')) { changeTask(id, { waitingCanceled: false }); await finish(id, task.results); return; }
        if (!task?.jobId) throw new Error('没有安全恢复编号；不会重新提交');
        changeTask(id, { waitingCanceled: false });
        try { await dependencies.transport.recover(task); await get().poll(id); }
        catch (error) { changeTask(id, { status: 'recoverable_wait', failure: classifyWorkbenchFailure(error) }); }
      },
      cancelWaiting(id) {
        clearTimeout(timers.get(id)); timers.delete(id);
        changeTask(id, { waitingCanceled: true });
      },
      async importResult(id, projectId, resultIndex = 0) {
        const task = get().tasks[id];
        const result = task?.results[resultIndex];
        if (!result) throw new Error('Result not found');
        return await importWorkbenchResult(result, task, projectId);
      },
    };
  });
}
export const useWorkbenchStore = createWorkbenchStore({ document: workbenchDocument, transport: workbenchTransport });
