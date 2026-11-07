const edits = new Map<string, Promise<unknown>>();

/** Serialize each project's read/edit/persist cycle without blocking unrelated projects. */
export async function enqueueProjectEdit<T>(projectId: string, edit: () => Promise<T>): Promise<T> {
  const previous = edits.get(projectId);
  const pending = (async () => {
    if (previous) await previous.catch(() => undefined);
    return await edit();
  })();
  edits.set(projectId, pending);
  try {
    return await pending;
  } finally {
    if (edits.get(projectId) === pending) edits.delete(projectId);
  }
}
