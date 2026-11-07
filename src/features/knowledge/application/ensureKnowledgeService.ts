import { useKnowledgeStore, type KnowledgeStore } from './knowledgeStore';
import type { KnowledgeService } from './knowledgeService';

const initializations = new WeakMap<KnowledgeStore, Promise<void>>();

/** Reopens saved authorization without a picker; concurrent Agent tools share initialization. */
export async function ensureKnowledgeService(store: KnowledgeStore = useKnowledgeStore): Promise<KnowledgeService> {
  let pending = initializations.get(store);
  if (!pending && store.getState().status !== 'ready') {
    if (store.getState().status === 'loading') {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const unsubscribe = store.subscribe((state) => {
        if (state.status === 'loading') return;
        unsubscribe();
        if (state.error) reject(state.error); else resolve();
      });
      pending = promise;
    } else {
      // Omit the argument: supplying the saved path would count as fresh explicit authorization.
      pending = Promise.resolve().then(() => store.getState().initialize());
    }
    initializations.set(store, pending);
    void pending.finally(() => { if (initializations.get(store) === pending) initializations.delete(store); }).catch(() => undefined);
  }
  await pending;
  return store.getState().getService();
}
