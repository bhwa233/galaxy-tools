import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Extracted from the existing package installer. Node rename has no retry
 * option; preserve callers' path/identity checks on every bounded attempt. */
export async function renameWithRetry(
  source: string,
  target: string,
  options: {
    signal?: AbortSignal;
    beforeAttempt?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    await options.beforeAttempt?.();
    options.signal?.throwIfAborted();
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 8 ||
        !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
      await delay(Math.min(50 * 2 ** attempt, 500), undefined, { signal: options.signal });
    }
  }
}
