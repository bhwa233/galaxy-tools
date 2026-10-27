import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError, atomicWrite, canonical, readJson } from "./persistence.js";

const rootsSchema = z
  .strictObject({
    version: z.literal(1),
    roots: z.array(z.string().max(32768)).max(4096),
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024,
    "Private root registry exceeds 1 MiB",
  );

/** Search exclusions only: this registry never grants filesystem access or
 * restore authority. Keep it outside the host directory replaced by restore. */
export class HostPrivateDataRootsStore {
  private roots: string[];
  private listeners = new Set<() => void | Promise<void>>();
  private operations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    initialRoots: readonly string[],
  ) {
    let saved: string[] = [];
    if (fs.existsSync(file)) {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new AppError("invalidPrivateDataRoots", "私有数据目录登记文件不合法");
      saved = rootsSchema.parse(readJson(file)).roots;
    }
    this.roots = this.normalized([...saved, ...initialRoots]);
    // Startup seeds are durable before any plugin or search process starts.
    if (!fs.existsSync(file) || JSON.stringify(saved) !== JSON.stringify(this.roots))
      atomicWrite(file, JSON.stringify({ version: 1, roots: this.roots }));
  }

  private normalized(roots: readonly string[]): string[] {
    const result = new Set<string>();
    for (const root of roots) {
      if (
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        path.resolve(root) === path.parse(root).root
      )
        throw new AppError("unsafePrivateDataRoot", "私有数据域必须是明确的应用目录");
      for (const value of [path.resolve(root), canonical(root)]) {
        if (value === path.parse(value).root)
          throw new AppError("unsafePrivateDataRoot", "私有数据域不能指向整个磁盘");
        result.add(value);
      }
    }
    return rootsSchema.parse({ version: 1, roots: [...result].sort() }).roots;
  }

  list(): string[] {
    return this.normalized(this.roots);
  }

  subscribe(listener: () => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  retain(roots: readonly string[]): Promise<void> {
    const operation = this.operations
      .catch(() => {})
      .then(async () => {
        const next = this.normalized([...this.roots, ...roots]);
        if (JSON.stringify(next) !== JSON.stringify(this.roots)) {
          atomicWrite(this.file, JSON.stringify({ version: 1, roots: next }));
          this.roots = next;
        }
        // Await cancellation even on retry after a previous listener failed. The
        // caller cannot create private content until old search sessions drain.
        const results = await Promise.allSettled(
          [...this.listeners].map((listener) => Promise.resolve().then(listener)),
        );
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, "私有数据目录已登记，搜索暂停尚未完成");
      });
    this.operations = operation;
    return operation;
  }
}
