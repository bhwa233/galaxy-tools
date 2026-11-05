import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire, Module } from "node:module";
import { setImmediate, clearImmediate } from "node:timers";
import { Buffer } from "node:buffer";

export function loadUToolsPreload(
  filename: string,
  environment: { process: NodeJS.Process; Buffer: typeof Buffer; global: typeof globalThis },
): unknown {
  // Reuse Node's compiler and module resolution. The extra bindings belong to
  // this trusted preload closure rather than the plugin page's global object.
  const localRequire = createRequire(filename);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = localRequire.resolve.paths("utools-preload") ?? [];
  module.require = localRequire;
  const source = fs.readFileSync(filename, "utf8").replace(/^#![^\n]*\n/, "");
  const execute = vm.compileFunction(
    source,
    [
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      "process",
      "Buffer",
      "global",
      "setImmediate",
      "clearImmediate",
    ],
    { filename },
  );
  execute.call(
    module.exports,
    module.exports,
    localRequire,
    module,
    filename,
    path.dirname(filename),
    environment.process,
    environment.Buffer,
    environment.global,
    setImmediate,
    clearImmediate,
  );
  module.loaded = true;
  return module.exports;
}

export function createUToolsCallbackQueue() {
  let lifecycle: Promise<unknown> = Promise.resolve();
  return <T>(operation: string, callback: () => T | Promise<T>): Promise<T> => {
    const result = lifecycle.then(callback);
    if (["ready", "enter", "out"].includes(operation)) lifecycle = result.catch(() => undefined);
    return result;
  };
}

export function projectUToolsList(rows: unknown) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error("列表超过处理预算或格式不正确");
  const list: Array<{ id: string; title: string; description: string }> = [];
  let bytes = 0;
  for (const [index, item] of rows.entries()) {
    const row = {
      id: String(index),
      title: String(item?.title || item?.text || "").slice(0, 1000),
      description: String(item?.description || "").slice(0, 2000),
    };
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (list.length >= 1000 || bytes > 192 * 1024) break;
    list.push(row);
  }
  return { rows: rows.slice(0, list.length), list, truncated: rows.length > list.length };
}
