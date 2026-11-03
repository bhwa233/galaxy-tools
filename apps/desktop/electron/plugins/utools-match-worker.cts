import { parentPort } from "node:worker_threads";
import type { UToolsFeature } from "./utools-manifest.js";

function expression(source: string): RegExp {
  const value = /^\/(.*)\/([imsu]*)$/.exec(source);
  return value ? new RegExp(value[1], value[2]) : new RegExp(source);
}
parentPort?.on(
  "message",
  ({
    id,
    features,
    text,
    context,
  }: {
    id: string;
    features: UToolsFeature[];
    text: string;
    context: { type: string; payload: unknown };
  }) => {
    try {
      const matches: Array<{
        code: string;
        type: string;
        label: string;
        payload: unknown;
        mainPush: boolean;
      }> = [];
      for (const feature of features)
        for (const cmd of feature.cmds) {
          if (typeof cmd === "string") {
            if (text && cmd.toLowerCase().includes(text.toLowerCase()))
              matches.push({
                code: feature.code,
                type: "text",
                label: cmd,
                payload: cmd,
                mainPush: !!feature.mainPush,
              });
            continue;
          }
          const value = typeof context.payload === "string" ? context.payload : text;
          if (cmd.type === "window") continue; // Missing title/class must not broaden matching.
          if (
            (cmd.type === "regex" || cmd.type === "over") &&
            (!value || (context.type !== "text" && text === ""))
          )
            continue;
          if (cmd.type === "img" && context.type !== "img") continue;
          if (cmd.type === "files" && context.type !== "files") continue;
          const payload = cmd.type === "files" || cmd.type === "img" ? context.payload : value;
          const length = Array.isArray(payload)
            ? payload.length
            : typeof payload === "string"
              ? payload.length
              : 0;
          if (
            cmd.type !== "img" &&
            (length < (cmd.minLength ?? 0) || length > (cmd.maxLength ?? 100000))
          )
            continue;
          if (
            cmd.type === "regex" &&
            (typeof cmd.match !== "string" || !expression(cmd.match).test(value))
          )
            continue;
          if (cmd.type === "over" && cmd.exclude && expression(cmd.exclude).test(value)) continue;
          if (cmd.type === "files") {
            const files = payload as Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
            if (
              !files.every(
                (file) =>
                  (!cmd.fileType || (cmd.fileType === "file" ? file.isFile : file.isDirectory)) &&
                  (!cmd.extensions ||
                    cmd.extensions.some((ext) =>
                      file.name.toLowerCase().endsWith("." + ext.toLowerCase().replace(/^\./, "")),
                    )) &&
                  (typeof cmd.match !== "string" || expression(cmd.match).test(file.name)),
              )
            )
              continue;
          }
          matches.push({
            code: feature.code,
            type: cmd.type,
            label: cmd.label,
            payload,
            mainPush: !!feature.mainPush,
          });
        }
      parentPort!.postMessage({ id, matches: matches.slice(0, 100) });
    } catch (error) {
      parentPort!.postMessage({ id, error: String(error) });
    }
  },
);
