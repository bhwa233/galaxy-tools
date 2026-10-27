/** Existing note surfaces own their save handlers. Launcher workspaces share a
 * per-renderer registry so host close/backup can await their pending writes. */
const handlers = new Set<() => Promise<void>>();
export function registerHostPreparation(handler: () => Promise<void>): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
export async function prepareHostWindow(): Promise<void> {
  for (const handler of handlers) await handler();
}
