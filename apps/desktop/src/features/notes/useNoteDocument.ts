import { useCallback, useEffect, useRef } from "react";
import { listen, reportClosePreparation } from "../../platform/desktop";
import { getErrorMessage } from "./api";

/** Compose the two existing note save queues; snapshots remain owned by each
 * editor because external files and note surfaces use different persistence APIs. */
export function useNoteDocument<Args extends unknown[], Result>(
  persist: (...args: Args) => Promise<Result>,
) {
  const latest = useRef(persist);
  latest.current = persist;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const save = useCallback((...args: Args): Promise<Result> => {
    pending.current++;
    const operation = queue.current.catch(() => {}).then(() => latest.current(...args));
    const completed = operation.finally(() => {
      pending.current--;
    });
    queue.current = completed.catch(() => {});
    return completed;
  }, []);
  const drain = useCallback(async (): Promise<void> => {
    // Reuse this document's queue. A close request must wait for existing
    // writes before deciding whether another snapshot still needs saving.
    let tail: Promise<unknown>;
    do {
      tail = queue.current;
      await tail;
    } while (tail !== queue.current);
  }, []);
  return { save, pending, drain };
}

export function useNoteClosePreparation(options: {
  save: () => Promise<unknown>;
  drain: () => Promise<void>;
  isDirty: () => boolean;
  isSaved: () => boolean;
  label: () => string;
  onFailure: (error: unknown) => void;
  failureMessage: string;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const subscription = listen("desktop:prepare-close", ({ payload }) => {
      const prepare = async () => {
        const current = latest.current;
        try {
          await current.drain();
          if (!current.isDirty()) {
            await reportClosePreparation(payload.requestId, current.label(), "ready");
            return;
          }
          await current.save();
          // Auto-save can enqueue while the requested write is in flight.
          // Its result must settle before pending/isSaved decide the reply.
          await current.drain();
          const ready = current.isSaved();
          await reportClosePreparation(
            payload.requestId,
            current.label(),
            ready ? "ready" : "failed",
            ready ? undefined : current.failureMessage,
          );
        } catch (error) {
          current.onFailure(error);
          await reportClosePreparation(
            payload.requestId,
            current.label(),
            "failed",
            getErrorMessage(error),
          );
        }
      };
      void prepare().catch((error) => latest.current.onFailure(error));
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, []);
}
