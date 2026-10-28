import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

/** Reuse the pinned Pulse/ib-matcher implementation in a package-local process.
 * This wrapper only owns session files, cancellation, bounded results and exit.
 * The host's general native controller is not a runtime dependency of npm plugins. */
export function createPinyinMatcher({ cacheDir, signal: lifetimeSignal }) {
  const root = realpathSync(fileURLToPath(new URL("./", import.meta.url)));
  const executable = realpathSync(
    fileURLToPath(new URL("./native/win32-x64/spark233.ApplicationMatcher.exe", import.meta.url)),
  );
  const relative = path.relative(root, executable);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("Application matcher escaped its validated package");
  const tasks = new Set();
  let stopping = false;
  const onLifetimeAbort = () => {
    for (const task of tasks) task.cancel();
  };
  lifetimeSignal.addEventListener("abort", onLifetimeAbort);
  return {
    match(names, query, querySignal) {
      if (stopping) return Promise.reject(new Error("Application matching is stopping"));
      lifetimeSignal.throwIfAborted();
      querySignal.throwIfAborted();
      const sessionId = randomUUID();
      const directory = path.join(cacheDir, "pinyin", sessionId);
      const task = {
        cancelled: false,
        directoryReady: false,
        cancel() {
          task.cancelled = true;
          if (task.directoryReady)
            void (async () => {
              const temporary = path.join(directory, randomUUID() + ".cancel");
              try {
                await fs.writeFile(temporary, sessionId, { flag: "wx" });
                await fs.rename(temporary, path.join(directory, "cancel.request"));
              } finally {
                await fs.rm(temporary, { force: true });
              }
            })().catch(() => {});
        },
        done: undefined,
      };
      const onAbort = () => task.cancel();
      const run = async () => {
        let child,
          close,
          exited = false,
          spawnFailure;
        querySignal.addEventListener("abort", onAbort, { once: true });
        lifetimeSignal.addEventListener("abort", onAbort, { once: true });
        const started = performance.now();
        try {
          if (querySignal.aborted || lifetimeSignal.aborted) task.cancel();
          await fs.mkdir(directory, { recursive: true });
          task.directoryReady = true;
          const request = JSON.stringify({ protocol: 1, sessionId, query, names });
          if (Buffer.byteLength(request) > 8 * 1024 * 1024)
            throw new Error("Application names exceed the native query budget");
          await fs.writeFile(path.join(directory, "request.json"), request, { flag: "wx" });
          if (task.cancelled) throw new Error("Application query cancelled");
          child = spawn(
            executable,
            [
              "--request",
              path.join(directory, "request.json"),
              "--parent-pid",
              String(process.pid),
            ],
            { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(0, 4096);
          });
          close = new Promise((resolve) => {
            child.once("error", (error) => {
              spawnFailure = error;
            });
            child.once("close", (code) => {
              exited = true;
              resolve(code);
            });
          });
          const code = await close;
          if (spawnFailure) throw new Error("Application pinyin helper failed to start");
          if (code !== 0)
            throw new Error(`Application pinyin helper failed (${code}): ${stderr.trim()}`);
          if (task.cancelled || querySignal.aborted || lifetimeSignal.aborted)
            throw new Error("Application query cancelled");
          const resultFile = path.join(directory, "result.json");
          if ((await fs.stat(resultFile)).size > 2 * 1024 * 1024)
            throw new Error("Application pinyin result exceeds its bound");
          const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
          if (
            result.protocol !== 1 ||
            result.sessionId !== sessionId ||
            result.pid !== child.pid ||
            !["ok", "cancelled"].includes(result.status) ||
            !Array.isArray(result.matches) ||
            result.matches.length > names.length
          )
            throw new Error("Application pinyin result has the wrong session identity");
          if (result.status === "cancelled") throw new Error("Application query cancelled");
          const indices = new Set();
          for (const match of result.matches) {
            if (
              !Number.isSafeInteger(match.index) ||
              match.index < 0 ||
              match.index >= names.length ||
              indices.has(match.index) ||
              !["full", "initials"].includes(match.kind) ||
              !Number.isSafeInteger(match.start) ||
              !Number.isSafeInteger(match.length) ||
              match.start < 0 ||
              match.length < 1 ||
              match.start + match.length > names[match.index].length
            )
              throw new Error("Application pinyin result has an invalid name span");
            indices.add(match.index);
          }
          return {
            matches: result.matches,
            pid: child.pid,
            exitCode: code,
            elapsedMs: performance.now() - started,
          };
        } finally {
          querySignal.removeEventListener("abort", onAbort);
          lifetimeSignal.removeEventListener("abort", onAbort);
          if (child && !exited) {
            task.cancel();
            await close;
          }
          await fs.rm(directory, { recursive: true, force: true });
        }
      };
      tasks.add(task);
      task.done = run().finally(() => tasks.delete(task));
      // Cancellation is expected during replacement/stop; the request owner
      // still receives its rejection without an unhandled background promise.
      void task.done.catch(() => {});
      return task.done;
    },
    async stop() {
      stopping = true;
      lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
      for (const task of tasks) task.cancel();
      await Promise.allSettled([...tasks].map((task) => task.done));
    },
  };
}
