interface Entry<Meta> {
  meta: Meta;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  release: () => void;
}

export interface OpenOptions<Meta> {
  /** Rejects with the returned error (or a generic one) after this delay. */
  timeoutMs: number;
  /** Runs once when the timer wins, e.g. to tell the other side to cancel. */
  onTimeout?: () => Error | void;
  /** Aborting rejects the request with the signal's reason or this message. */
  signal?: AbortSignal;
  abortMessage?: string;
  meta: Meta;
}

/**
 * The request table every plugin runtime needs: id → settle callbacks with a
 * timer, optional abort signal and a size cap. Settling is idempotent and always
 * releases the timer and listener, so stop, crash and timeout paths cannot leak
 * or settle a request twice.
 */
export class PendingRequests<Meta = undefined> {
  private readonly entries = new Map<string, Entry<Meta>>();

  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}

  get size(): number {
    return this.entries.size;
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  meta(id: string): Meta | undefined {
    return this.entries.get(id)?.meta;
  }
  ids(): string[] {
    return [...this.entries.keys()];
  }

  open<T = unknown>(id: string, options: OpenOptions<Meta>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.entries.size >= this.limit) return reject(new Error("Too many pending requests"));
      if (options.signal?.aborted)
        return reject(new Error(options.abortMessage ?? "Request cancelled"));
      const timer = setTimeout(() => {
        const error = options.onTimeout?.() ?? new Error("Request timed out");
        this.reject(id, error);
      }, options.timeoutMs);
      const abort = () => this.reject(id, new Error(options.abortMessage ?? "Request cancelled"));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.entries.set(id, {
        meta: options.meta,
        resolve: resolve as (value: unknown) => void,
        reject,
        release: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      });
    });
  }

  resolve(id: string, value: unknown): boolean {
    const entry = this.take(id);
    entry?.resolve(value);
    return !!entry;
  }
  reject(id: string, error: Error): boolean {
    const entry = this.take(id);
    entry?.reject(error);
    return !!entry;
  }
  rejectAll(error: Error): void {
    for (const id of this.ids()) this.reject(id, error);
  }

  private take(id: string): Entry<Meta> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    entry.release();
    return entry;
  }
}
